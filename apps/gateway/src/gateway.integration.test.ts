import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildApp as buildControlPlane,
  createDb,
  runMigrations,
  schema,
  type Db,
} from "@scad/control-plane";
import { FakeIdentityProvider } from "./auth/identity.js";
import { issueLoginCode, consumeLoginCode, LoginCodeError } from "./auth/login-codes.js";
import { buildGateway, type GatewayInstance } from "./app.js";
import { SESSION_COOKIE, sessionCookieOptions } from "./cookies.js";
import { appHost, authHost } from "./host.js";
import { createHttpAppResolver } from "./resolve.js";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const INTERNAL_SECRET = "test-internal-secret";

describe.runIf(Boolean(databaseUrl))("gateway v0 auth (Postgres)", () => {
  let dbBundle: Db;
  let gateway: GatewayInstance;
  let identity: FakeIdentityProvider;
  let ownerId: string;
  let otherUserId: string;
  let controlPlane: Awaited<ReturnType<typeof buildControlPlane>>;

  const ownerHost = appHost("hello", "alice", BASE_DOMAIN);
  const otherAppHost = appHost("other", "alice", BASE_DOMAIN);
  const auth = authHost(BASE_DOMAIN);

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);

    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);

    const [owner] = await dbBundle.db
      .insert(schema.users)
      .values({
        email: "alice@example.com",
        handle: "alice",
        displayName: "Alice",
        githubId: "1001",
        role: "member",
        status: "active",
      })
      .returning();
    if (!owner) throw new Error("owner insert failed");
    ownerId = owner.id;

    const [other] = await dbBundle.db
      .insert(schema.users)
      .values({
        email: "bob@example.com",
        handle: "bob",
        displayName: "Bob",
        githubId: "1002",
        role: "member",
        status: "active",
      })
      .returning();
    if (!other) throw new Error("other insert failed");
    otherUserId = other.id;

    await dbBundle.db.insert(schema.apps).values([
      { slug: "hello", ownerId, status: "running" },
      { slug: "other", ownerId, status: "running" },
    ]);

    controlPlane = await buildControlPlane({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      baseDomain: BASE_DOMAIN,
    });
    await controlPlane.ready();

    // Drive /internal/resolve through the live control-plane inject transport.
    const resolver = {
      async resolve(host: string) {
        const res = await controlPlane.inject({
          method: "POST",
          url: "/internal/resolve",
          headers: { "x-scad-internal-secret": INTERNAL_SECRET },
          payload: { host },
        });
        if (res.statusCode === 404) return null;
        if (res.statusCode !== 200) {
          throw new Error(`resolve ${res.statusCode}: ${res.body}`);
        }
        return res.json();
      },
    };

    identity = new FakeIdentityProvider();
    gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity,
      resolver,
      allowDevLogin: true,
    });
    await gateway.ready();
  });

  afterAll(async () => {
    await gateway?.close();
    await controlPlane?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  async function completeGithubLogin(profile: {
    githubId: string;
    login: string;
    email: string;
    name: string;
  }, targetHost: string) {
    const returnTo = `http://${targetHost}/`;
    const loginRes = await gateway.inject({
      method: "GET",
      url: `/login?return_to=${encodeURIComponent(returnTo)}`,
      headers: { host: auth },
    });
    expect(loginRes.statusCode).toBe(302);
    const location = loginRes.headers.location;
    expect(location).toBeTruthy();
    const authUrl = new URL(location!);
    const state = authUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const code = identity.issueCodeFor(profile);
    const cb = await gateway.inject({
      method: "POST",
      url: "/login/dev/callback",
      headers: { host: auth },
      payload: { code, state },
    });
    expect(cb.statusCode).toBe(302);
    const appCallback = new URL(cb.headers.location!);
    expect(appCallback.host).toBe(targetHost);
    expect(appCallback.pathname).toBe("/__scad/callback");

    const exchanged = await gateway.inject({
      method: "GET",
      url: appCallback.pathname + appCallback.search,
      headers: { host: targetHost },
    });
    expect(exchanged.statusCode).toBe(302);
    const setCookie = exchanged.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
    expect(cookieHeader.toLowerCase()).not.toContain("domain=");
    const match = /scad_session=([^;]+)/.exec(cookieHeader);
    expect(match).toBeTruthy();
    return match![1]!;
  }

  it("unauthenticated request redirects to auth host then back and shows the app", async () => {
    const unauth = await gateway.inject({
      method: "GET",
      url: "/",
      headers: { host: ownerHost },
    });
    expect(unauth.statusCode).toBe(302);
    const loc = new URL(unauth.headers.location!);
    expect(loc.host).toBe(auth);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("return_to")).toBe(`http://${ownerHost}/`);

    const session = await completeGithubLogin(
      {
        githubId: "1001",
        login: "alice",
        email: "alice@example.com",
        name: "Alice",
      },
      ownerHost,
    );

    const appRes = await gateway.inject({
      method: "GET",
      url: "/",
      headers: {
        host: ownerHost,
        cookie: `${SESSION_COOKIE}=${session}`,
      },
    });
    expect(appRes.statusCode).toBe(200);
    expect(appRes.body).toContain("data-scad-app=\"hello\"");
    expect(appRes.body).toContain("is ready");
  });

  it("a different GitHub user gets 403", async () => {
    const session = await completeGithubLogin(
      {
        githubId: "1002",
        login: "bob",
        email: "bob@example.com",
        name: "Bob",
      },
      ownerHost,
    );

    const appRes = await gateway.inject({
      method: "GET",
      url: "/",
      headers: {
        host: ownerHost,
        cookie: `${SESSION_COOKIE}=${session}`,
      },
    });
    expect(appRes.statusCode).toBe(403);
    expect(appRes.body).toContain("403");
    expect(otherUserId).toBeTruthy();
  });

  it("cookie from app A is rejected on app B (INV4)", async () => {
    expect(sessionCookieOptions(BASE_DOMAIN)).not.toHaveProperty("domain");

    const session = await completeGithubLogin(
      {
        githubId: "1001",
        login: "alice",
        email: "alice@example.com",
        name: "Alice",
      },
      ownerHost,
    );

    const onB = await gateway.inject({
      method: "GET",
      url: "/",
      headers: {
        host: otherAppHost,
        cookie: `${SESSION_COOKIE}=${session}`,
      },
    });
    // Host-bound session: treated as unauthenticated → redirect to login
    expect(onB.statusCode).toBe(302);
    expect(onB.headers.location).toContain(`auth.${BASE_DOMAIN}/login`);
  });

  it("login code reuse and expiry fail (INV5)", async () => {
    const code = await issueLoginCode(dbBundle.db, {
      userId: ownerId,
      appHost: ownerHost,
    });

    const first = await consumeLoginCode(dbBundle.db, { code, appHost: ownerHost });
    expect(first.userId).toBe(ownerId);

    await expect(consumeLoginCode(dbBundle.db, { code, appHost: ownerHost })).rejects.toBeInstanceOf(
      LoginCodeError,
    );
    await expect(consumeLoginCode(dbBundle.db, { code, appHost: ownerHost })).rejects.toMatchObject({
      reason: "reused",
    });

    const expiredCode = await issueLoginCode(dbBundle.db, {
      userId: ownerId,
      appHost: ownerHost,
      now: new Date(Date.now() - 120_000),
    });
    await expect(
      consumeLoginCode(dbBundle.db, { code: expiredCode, appHost: ownerHost }),
    ).rejects.toMatchObject({ reason: "expired" });
  });
});

describe.runIf(Boolean(databaseUrl))("createHttpAppResolver", () => {
  it("is exported for production wiring", () => {
    expect(typeof createHttpAppResolver).toBe("function");
  });
});
