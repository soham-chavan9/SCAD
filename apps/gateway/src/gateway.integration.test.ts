import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
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
import { generateEphemeralIdentityKeys } from "./identity/keys.js";
import { createHttpAppResolver } from "./resolve.js";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const INTERNAL_SECRET = "test-internal-secret";

describe.runIf(Boolean(databaseUrl))("gateway v0 auth + proxy (Postgres)", () => {
  let dbBundle: Db;
  let gateway: GatewayInstance;
  let identity: FakeIdentityProvider;
  let ownerId: string;
  let otherUserId: string;
  let controlPlane: Awaited<ReturnType<typeof buildControlPlane>>;
  let echo: Server;
  let echoPort: number;
  let appIdHello: string;

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

    echo = createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          email: req.headers["x-scad-user-email"] ?? null,
          userId: req.headers["x-scad-user-id"] ?? null,
          name: req.headers["x-scad-user-name"] ?? null,
          identity: req.headers["x-scad-identity"] ?? null,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      echo.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = echo.address();
    if (!addr || typeof addr === "string") throw new Error("no echo port");
    echoPort = addr.port;

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

    const [helloApp] = await dbBundle.db
      .insert(schema.apps)
      .values([
        { slug: "hello", ownerId, status: "running" },
        { slug: "other", ownerId, status: "running" },
      ])
      .returning();
    if (!helloApp) throw new Error("app insert failed");
    appIdHello = helloApp.id;

    controlPlane = await buildControlPlane({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      baseDomain: BASE_DOMAIN,
    });
    await controlPlane.ready();

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
        const base = res.json() as Record<string, unknown>;
        return {
          ...base,
          upstreamHost: "127.0.0.1",
          port: echoPort,
        };
      },
    };

    identity = new FakeIdentityProvider();
    const keys = await generateEphemeralIdentityKeys();
    gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity,
      resolver,
      keys,
      allowDevLogin: true,
    });
    await gateway.ready();
  });

  afterAll(async () => {
    await gateway?.close();
    await controlPlane?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await new Promise<void>((resolve, reject) => {
      echo.close((err) => (err ? reject(err) : resolve()));
    });
  });

  async function completeGithubLogin(
    profile: {
      githubId: string;
      login: string;
      email: string;
      name: string;
    },
    targetHost: string,
  ) {
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

  it("unauthenticated request redirects to auth host then back and shows verified email", async () => {
    const unauth = await gateway.inject({
      method: "GET",
      url: "/",
      headers: { host: ownerHost },
    });
    expect(unauth.statusCode).toBe(302);
    expect(new URL(unauth.headers.location!).host).toBe(auth);

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
        "x-scad-user-email": "forged@evil.test",
      },
    });
    expect(appRes.statusCode).toBe(200);
    const body = appRes.json() as {
      email: string;
      userId: string;
      identity: string;
    };
    expect(body.email).toBe("alice@example.com");
    expect(body.userId).toBe(ownerId);
    expect(body.identity).toBeTruthy();

    const jwksRes = await gateway.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
      headers: { host: auth },
    });
    expect(jwksRes.statusCode).toBe(200);
    const jwks = createLocalJWKSet(jwksRes.json());
    const { payload } = await jwtVerify(body.identity, jwks, {
      issuer: `http://${auth}`,
      audience: appIdHello,
    });
    expect(payload["email"]).toBe("alice@example.com");

    await expect(
      jwtVerify(body.identity, jwks, {
        issuer: `http://${auth}`,
        audience: "wrong-app-id",
      }),
    ).rejects.toThrow();
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
    expect(onB.statusCode).toBe(302);
    expect(onB.headers.location).toContain(`auth.${BASE_DOMAIN}/login`);
  });

  it("/__scad/* paths other than callback never reach the app", async () => {
    const session = await completeGithubLogin(
      {
        githubId: "1001",
        login: "alice",
        email: "alice@example.com",
        name: "Alice",
      },
      ownerHost,
    );

    const res = await gateway.inject({
      method: "GET",
      url: "/__scad/should-not-proxy",
      headers: {
        host: ownerHost,
        cookie: `${SESSION_COOKIE}=${session}`,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("alice@example.com");
  });

  it("login code reuse and expiry fail (INV5)", async () => {
    const code = await issueLoginCode(dbBundle.db, {
      userId: ownerId,
      appHost: ownerHost,
    });

    const first = await consumeLoginCode(dbBundle.db, { code, appHost: ownerHost });
    expect(first.userId).toBe(ownerId);

    await expect(consumeLoginCode(dbBundle.db, { code, appHost: ownerHost })).rejects.toMatchObject({
      reason: "reused",
    });
    expect(LoginCodeError).toBeTruthy();

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
