import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertTruncateAllowed,
  buildApp as buildControlPlane,
  createDb,
  issuePat,
  runMigrations,
  schema,
  type Db,
} from "@scad/control-plane";
import {
  appHost,
  buildGateway,
  FakeIdentityProvider,
  generateEphemeralIdentityKeys,
  issueLoginCode,
  MemoryMailer,
  type AppResolver,
  type ResolvedApp,
} from "@scad/gateway";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const INTERNAL_SECRET = "adv-public-secret";
const PER_IP = 5;

/**
 * T3.5: public links (anyone with the link, no sign-in) against the real
 * gateway and control plane. The default stays private; a public site still
 * strips spoofed identity (INV3), is switched off within 5 s (INV9), is not
 * for search engines, and rate-limits anonymous traffic per IP.
 */
describe.runIf(Boolean(databaseUrl))("public links under attack (T3.5)", () => {
  let dbBundle: Db;
  let controlPlane: Awaited<ReturnType<typeof buildControlPlane>>;
  let gateway: Awaited<ReturnType<typeof buildGateway>>;
  let echo: Server;
  let echoPort: number;
  let ownerPat: string;
  let operatorPat: string;
  let ownerId: string;
  let viewerId: string;
  let siteId: string;
  let ip = 0;

  const siteHost = appHost("site", "olive", BASE_DOMAIN);
  const secretHost = appHost("secret", "olive", BASE_DOMAIN);

  /** A fresh client IP per call unless one is given, so the rate limit only bites where a test wants it. */
  const get = (host: string, headers: Record<string, string> = {}, remoteAddress = `203.0.113.${(++ip % 250) + 1}`) =>
    gateway.inject({ method: "GET", url: "/", headers: { host, accept: "text/html", ...headers }, remoteAddress });

  const cp = (method: "PATCH" | "POST", url: string, pat: string, payload?: Record<string, unknown>) =>
    controlPlane.inject({ method, url, headers: { authorization: `Bearer ${pat}` }, ...(payload ? { payload } : {}) });

  async function sessionCookie(userId: string, host: string): Promise<string> {
    const code = await issueLoginCode(dbBundle.db, { userId, appHost: host });
    const res = await gateway.inject({
      method: "GET",
      url: `/__scad/callback?code=${encodeURIComponent(code)}&return_to=%2F`,
      headers: { host },
    });
    expect(res.statusCode).toBe(302);
    return /scad_session=([^;]+)/.exec(String(res.headers["set-cookie"]))![1]!;
  }

  /** Poll until `check` passes; returns how long it took. */
  async function within(ms: number, check: () => Promise<boolean>): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await check()) return Date.now() - start;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`not within ${ms} ms`);
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);

    echo = createServer((req, res) => {
      const scad = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-scad-")));
      res.setHeader("content-type", "application/json");
      // A hostile app trying to get its public site indexed anyway.
      res.setHeader("x-robots-tag", "all");
      res.end(JSON.stringify({ scad }));
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const addr = echo.address();
    if (!addr || typeof addr === "string") throw new Error("no echo port");
    echoPort = addr.port;

    controlPlane = await buildControlPlane({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      internalToken: "adv-public-token",
      baseDomain: BASE_DOMAIN,
      operatorEmails: ["op@example.com"],
    });
    await controlPlane.ready();
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
    gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity: new FakeIdentityProvider(),
      resolver,
      keys: await generateEphemeralIdentityKeys(),
      mailer: new MemoryMailer(),
      publicPerIpPerMinute: PER_IP,
    });
    await gateway.ready();
  });

  beforeEach(async () => {
    await dbBundle.client.unsafe(
      "TRUNCATE TABLE app_access, login_codes, sessions, audit_events, machines, releases, pats, apps, users RESTART IDENTITY CASCADE",
    );
    const [olive, vic, op] = await dbBundle.db
      .insert(schema.users)
      .values([
        { email: "olive@example.com", handle: "olive", displayName: "Olive" },
        { email: "vic@example.com", handle: "vic", displayName: "Vic" },
        { email: "op@example.com", handle: "op", displayName: "Op" },
      ])
      .returning();
    if (!olive || !vic || !op) throw new Error("insert failed");
    ownerId = olive.id;
    viewerId = vic.id;
    const ownerIssued = issuePat();
    const opIssued = issuePat();
    ownerPat = ownerIssued.token;
    operatorPat = opIssued.token;
    await dbBundle.db.insert(schema.pats).values([
      { userId: olive.id, tokenHash: ownerIssued.tokenHash, name: "t" },
      { userId: op.id, tokenHash: opIssued.tokenHash, name: "t" },
    ]);
    const [site] = await dbBundle.db
      .insert(schema.apps)
      .values([
        { slug: "site", ownerId: olive.id, status: "running" },
        { slug: "secret", ownerId: olive.id, status: "running" },
      ])
      .returning();
    if (!site) throw new Error("insert failed");
    siteId = site.id;
    const made = await cp("PATCH", "/v1/apps/site", ownerPat, { visibility: "public" });
    expect(made.statusCode).toBe(200);
  });

  afterAll(async () => {
    await gateway?.close();
    await controlPlane?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it("a new app is private by default", async () => {
    const [secret] = await dbBundle.client<{ visibility: string }[]>`SELECT visibility FROM apps WHERE slug = 'secret'`;
    expect(secret?.visibility).toBe("allowlist");
  });

  it("a signed-out browser sees a public site and gets the sign-in page for a private one", async () => {
    const pub = await get(siteHost);
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toEqual({ scad: {} });
    const priv = await get(secretHost);
    expect(priv.statusCode).toBe(302);
    expect(priv.headers.location).toMatch(/^http:\/\/auth\.localhost:8080\/login\?return_to=/);
  });

  it("public sites are noindex even if the app says otherwise; private ones are not touched", async () => {
    const pub = await get(siteHost);
    expect(pub.headers["x-robots-tag"]).toBe("noindex, nofollow");
    const ownerCookie = await sessionCookie(ownerId, secretHost);
    const priv = await get(secretHost, { cookie: `scad_session=${ownerCookie}` });
    expect(priv.statusCode).toBe(200);
    expect(priv.headers["x-robots-tag"]).toBe("all");
  });

  it("INV3: spoofed identity headers never reach a public app from an anonymous visitor", async () => {
    const res = await get(siteHost, {
      "x-scad-user-email": "olive@example.com",
      "x-scad-user-id": ownerId,
      "x-scad-user-name": "Olive",
      "x-scad-identity": "eyJhbGciOiJFZERTQSJ9.e30.forged",
      "X-SCAD-Extra": "1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scad: {} });
  });

  it("INV3: a signed-in viewer of a public site gets only the gateway's identity", async () => {
    const cookie = await sessionCookie(viewerId, siteHost);
    const res = await get(siteHost, { cookie: `scad_session=${cookie}`, "x-scad-user-email": "olive@example.com" });
    const scad = (res.json() as { scad: Record<string, string> }).scad;
    expect(scad["x-scad-user-email"]).toBe("vic@example.com");
    expect(scad["x-scad-user-id"]).toBe(viewerId);
    expect(scad["x-scad-identity"]?.split(".")).toHaveLength(3);
  });

  it("switching public to private blocks a signed-out viewer within 5 s, and writes an audit row", async () => {
    expect((await get(siteHost)).statusCode).toBe(200);
    const res = await cp("PATCH", "/v1/apps/site", ownerPat, { visibility: "allowlist" });
    expect(res.statusCode).toBe(200);
    const took = await within(5_000, async () => (await get(siteHost)).statusCode === 302);
    expect(took).toBeLessThan(5_000);
    const audit = await dbBundle.client<{ metadata: unknown }[]>`
      SELECT metadata FROM audit_events WHERE app_id = ${siteId} AND action = 'app.visibility' ORDER BY at`;
    expect(audit.map((a) => a.metadata)).toEqual([
      { from: "allowlist", to: "public" },
      { from: "public", to: "allowlist" },
    ]);
  });

  it("INV9: operator suspend blocks a public site within 5 s, signed out or in", async () => {
    const cookie = await sessionCookie(viewerId, siteHost);
    const res = await cp("POST", `/v1/admin/apps/${siteId}/suspend`, operatorPat);
    expect(res.statusCode).toBe(200);
    await within(5_000, async () => (await get(siteHost)).statusCode === 403);
    expect((await get(siteHost, { cookie: `scad_session=${cookie}` })).statusCode).toBe(403);
  });

  it("a suspended owner's public site is not served", async () => {
    await dbBundle.client`UPDATE users SET status = 'suspended' WHERE id = ${ownerId}`;
    expect((await get(siteHost)).statusCode).toBe(403);
  });

  it("an expired public site is not served", async () => {
    await dbBundle.client`UPDATE apps SET expires_at = now() - interval '1 second' WHERE id = ${siteId}`;
    expect((await get(siteHost)).statusCode).toBe(403);
  });

  it("anonymous visitors are rate-limited per IP; other IPs and signed-in viewers are not", async () => {
    const attacker = "198.51.100.7";
    for (let i = 0; i < PER_IP; i++) {
      expect((await get(siteHost, {}, attacker)).statusCode).toBe(200);
    }
    const limited = await get(siteHost, {}, attacker);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.body).toMatch(/Too many requests/);
    const api = await gateway.inject({
      method: "GET",
      url: "/data.json",
      headers: { host: siteHost, accept: "application/json" },
      remoteAddress: attacker,
    });
    expect(api.statusCode).toBe(429);
    expect(api.json()).toMatchObject({ code: "RATE_LIMITED", hint: expect.any(String) });

    expect((await get(siteHost, {}, "198.51.100.8")).statusCode).toBe(200);
    const cookie = await sessionCookie(viewerId, siteHost);
    expect((await get(siteHost, { cookie: `scad_session=${cookie}` }, attacker)).statusCode).toBe(200);
  });

  it("a forged or cross-app cookie on a public site is just an anonymous visit", async () => {
    const otherCookie = await sessionCookie(viewerId, secretHost);
    for (const cookie of ["scad_session=not-a-session", `scad_session=${otherCookie}`]) {
      const res = await get(siteHost, { cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ scad: {} });
    }
  });
});
