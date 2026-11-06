import { createServer, type Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertTruncateAllowed,
  buildApp as buildControlPlane,
  createDb,
  issuePat,
  runMigrations,
  schema,
  type Db,
} from "@scad/control-plane";
import { FakeIdentityProvider } from "./auth/identity.js";
import { createSession } from "./auth/sessions.js";
import { buildGateway, type GatewayInstance } from "./app.js";
import { SESSION_COOKIE } from "./cookies.js";
import { appHost, authHost } from "./host.js";
import { generateEphemeralIdentityKeys } from "./identity/keys.js";
import { MemoryMailer } from "./mail/mailer.js";
import type { AppResolver, ResolvedApp } from "./resolve.js";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const INTERNAL_SECRET = "share-test-secret";

type Cookies = Record<string, string>;

function readSetCookies(header: string | string[] | undefined): Cookies {
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const out: Cookies = {};
  for (const c of list) {
    const [pair] = c.split(";");
    const idx = pair?.indexOf("=") ?? -1;
    if (pair && idx > 0) out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

const cookieHeader = (c: Cookies) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

function hiddenInput(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m?.[1]) throw new Error(`no hidden input ${name}`);
  return m[1].replaceAll("&amp;", "&");
}

describe.runIf(Boolean(databaseUrl))("allowlists and sharing (T1.2)", () => {
  let dbBundle: Db;
  let controlPlane: Awaited<ReturnType<typeof buildControlPlane>>;
  let gateway: GatewayInstance;
  let echo: Server;
  let echoPort: number;
  let mailer: MemoryMailer;
  let appId: string;
  let ownerPat: string;
  let strangerPat: string;
  let strangerId: string;

  const auth = authHost(BASE_DOMAIN);
  const host = appHost("board", "olive", BASE_DOMAIN);

  async function cp(method: "GET" | "POST" | "DELETE" | "PATCH", url: string, pat: string, payload?: unknown) {
    return controlPlane.inject({
      method,
      url,
      headers: { authorization: `Bearer ${pat}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  async function sessionFor(userId: string): Promise<Cookies> {
    const s = await createSession(dbBundle.db, { userId, appHost: host });
    return { [SESSION_COOKIE]: s.id };
  }

  async function visit(cookies: Cookies) {
    return gateway.inject({ method: "GET", url: "/", headers: { host, cookie: cookieHeader(cookies) } });
  }

  /** Full magic-link sign-in for `email`, returning the app-host session cookie. */
  async function magicLinkSignIn(email: string): Promise<Cookies> {
    mailer.sent.length = 0;
    const returnTo = `http://${host}/`;
    const login = await gateway.inject({
      method: "GET",
      url: `/login?return_to=${encodeURIComponent(returnTo)}`,
      headers: { host: auth },
    });
    const c1 = readSetCookies(login.headers["set-cookie"]);
    const req = await gateway.inject({
      method: "POST",
      url: "/login/email",
      headers: {
        host: auth,
        cookie: cookieHeader(c1),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ email, return_to: returnTo, csrf: hiddenInput(login.body, "csrf") }).toString(),
    });
    expect(req.statusCode).toBe(200);
    expect(mailer.sent, `a link should be sent to ${email}`).toHaveLength(1);
    const link = new URL(/(http\S+verify\?token=\S+)/.exec(mailer.sent[0]!.text)![1]!);
    const page = await gateway.inject({ method: "GET", url: link.pathname + link.search, headers: { host: auth } });
    const c2 = readSetCookies(page.headers["set-cookie"]);
    const verify = await gateway.inject({
      method: "POST",
      url: "/login/email/verify",
      headers: {
        host: auth,
        cookie: cookieHeader({ ...c1, ...c2 }),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        token: hiddenInput(page.body, "token"),
        csrf: hiddenInput(page.body, "csrf"),
      }).toString(),
    });
    expect(verify.statusCode).toBe(302);
    const cb = new URL(verify.headers.location!);
    const exchanged = await gateway.inject({ method: "GET", url: cb.pathname + cb.search, headers: { host } });
    expect(exchanged.statusCode).toBe(302);
    return readSetCookies(exchanged.headers["set-cookie"]);
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines,
        releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);

    echo = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ email: req.headers["x-scad-user-email"] ?? null }));
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const addr = echo.address();
    if (!addr || typeof addr === "string") throw new Error("no echo port");
    echoPort = addr.port;

    const [olive, sam] = await dbBundle.db
      .insert(schema.users)
      .values([
        { email: "olive@example.com", handle: "olive", displayName: "Olive" },
        { email: "sam@example.com", handle: "sam", displayName: "Sam" },
      ])
      .returning();
    if (!olive || !sam) throw new Error("insert failed");
    strangerId = sam.id;
    const ownerIssued = issuePat();
    const strangerIssued = issuePat();
    ownerPat = ownerIssued.token;
    strangerPat = strangerIssued.token;
    await dbBundle.db.insert(schema.pats).values([
      { userId: olive.id, tokenHash: ownerIssued.tokenHash, name: "t" },
      { userId: sam.id, tokenHash: strangerIssued.tokenHash, name: "t" },
    ]);
    const [app] = await dbBundle.db
      .insert(schema.apps)
      .values({ slug: "board", ownerId: olive.id, status: "running" })
      .returning();
    if (!app) throw new Error("insert failed");
    appId = app.id;

    controlPlane = await buildControlPlane({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      internalToken: "share-test-token",
      baseDomain: BASE_DOMAIN,
    });
    await controlPlane.ready();

    // Real /internal/resolve, then point the upstream at the local echo server.
    const resolver: AppResolver = {
      async resolve(h) {
        const res = await controlPlane.inject({
          method: "POST",
          url: "/internal/resolve",
          headers: { "x-scad-internal-secret": INTERNAL_SECRET },
          payload: { host: h },
        });
        if (res.statusCode === 404) return null;
        return { ...(res.json() as ResolvedApp), upstreamHost: "127.0.0.1", port: echoPort };
      },
    };

    mailer = new MemoryMailer();
    gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity: new FakeIdentityProvider(),
      resolver,
      keys: await generateEphemeralIdentityKeys(),
      mailer,
    });
    await gateway.ready();
  });

  afterAll(async () => {
    await gateway?.close();
    await controlPlane?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it("owner shares with an email that has no account yet", async () => {
    const res = await cp("POST", `/v1/apps/${appId}/share`, ownerPat, { email: "Friend@Example.com" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "friend@example.com" });

    const again = await cp("POST", `/v1/apps/board/share`, ownerPat, { email: "friend@example.com" });
    expect(again.statusCode).toBe(201); // idempotent, by slug too

    const list = await cp("GET", `/v1/apps/${appId}/share`, ownerPat);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      visibility: "allowlist",
      viewers: [{ email: "friend@example.com" }],
    });

    const audit = await dbBundle.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.appId, appId), eq(schema.auditEvents.action, "app.share")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("first sign-in with the shared email creates and links the account, and the friend gets in", async () => {
    const cookies = await magicLinkSignIn("friend@example.com");
    const page = await visit(cookies);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ email: "friend@example.com" });

    const [friend] = await dbBundle.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "friend@example.com"));
    expect(friend?.status).toBe("active");
    expect(friend?.handle).toMatch(/^friend/);
  });

  it("a signed-in user who is not on the allowlist gets 403", async () => {
    const page = await visit(await sessionFor(strangerId));
    expect(page.statusCode).toBe(403);
  });

  it("unshare takes effect within 5 seconds", async () => {
    const cookies = await magicLinkSignIn("friend@example.com");
    expect((await visit(cookies)).statusCode).toBe(200);

    const res = await cp("DELETE", `/v1/apps/${appId}/share/${encodeURIComponent("FRIEND@example.com")}`, ownerPat);
    expect(res.statusCode).toBe(200);

    const started = Date.now();
    let status = 0;
    while (Date.now() - started < 5000) {
      status = (await visit(cookies)).statusCode;
      if (status === 403) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe(403);
    expect(Date.now() - started).toBeLessThan(5000);

    const audit = await dbBundle.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.appId, appId), eq(schema.auditEvents.action, "app.unshare")));
    expect(audit).toHaveLength(1);
  });

  it("visibility=instance lets any active user in; allowlist puts it back", async () => {
    const stranger = await sessionFor(strangerId);
    const toInstance = await cp("PATCH", `/v1/apps/${appId}`, ownerPat, { visibility: "instance" });
    expect(toInstance.statusCode).toBe(200);
    expect(toInstance.json()).toMatchObject({ app: { visibility: "instance" } });
    expect((await visit(stranger)).statusCode).toBe(200);

    const back = await cp("PATCH", `/v1/apps/${appId}`, ownerPat, { visibility: "allowlist" });
    expect(back.statusCode).toBe(200);
    expect((await visit(stranger)).statusCode).toBe(403);
  });

  it("owners cannot manage others' apps (INV10)", async () => {
    const attempts = [
      await cp("POST", `/v1/apps/${appId}/share`, strangerPat, { email: "sam2@example.com" }),
      await cp("GET", `/v1/apps/${appId}/share`, strangerPat),
      await cp("DELETE", `/v1/apps/${appId}/share/friend@example.com`, strangerPat),
      await cp("PATCH", `/v1/apps/${appId}`, strangerPat, { visibility: "instance" }),
      await cp("GET", `/v1/apps/${appId}`, strangerPat),
    ];
    for (const res of attempts) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND", hint: expect.any(String) });
    }
    const rows = await dbBundle.db
      .select()
      .from(schema.appAccess)
      .where(eq(schema.appAccess.email, "sam2@example.com"));
    expect(rows).toHaveLength(0);
    const [app] = await dbBundle.db.select().from(schema.apps).where(eq(schema.apps.id, appId));
    expect(app?.visibility).toBe("allowlist");

    const mine = await cp("GET", "/v1/apps", strangerPat);
    expect((mine.json() as { apps: unknown[] }).apps).toHaveLength(0);
  });

  it("rejects an invalid email with VALIDATION_FAILED and a hint", async () => {
    const res = await cp("POST", `/v1/apps/${appId}/share`, ownerPat, { email: "not-an-email" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", hint: expect.any(String) });
  });

  it("no magic link for an email that is neither a user nor shared", async () => {
    mailer.sent.length = 0;
    const returnTo = `http://${host}/`;
    const login = await gateway.inject({
      method: "GET",
      url: `/login?return_to=${encodeURIComponent(returnTo)}`,
      headers: { host: auth },
    });
    const res = await gateway.inject({
      method: "POST",
      url: "/login/email",
      headers: {
        host: auth,
        cookie: cookieHeader(readSetCookies(login.headers["set-cookie"])),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        email: "random@example.com",
        return_to: returnTo,
        csrf: hiddenInput(login.body, "csrf"),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(0);
  });
});
