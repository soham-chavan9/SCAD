import { createServer, type Server } from "node:http";
import net from "node:net";
import { eq, sql } from "drizzle-orm";
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
import { FakeIdentityProvider } from "./auth/identity.js";
import { createMagicLink } from "./auth/magic-links.js";
import { createSession } from "./auth/sessions.js";
import { buildGateway, type GatewayInstance } from "./app.js";
import { SESSION_COOKIE } from "./cookies.js";
import { appHost, authHost } from "./host.js";
import { generateEphemeralIdentityKeys } from "./identity/keys.js";
import { MemoryMailer } from "./mail/mailer.js";
import type { AppResolver, ResolvedApp } from "./resolve.js";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const INTERNAL_SECRET = "operator-test-secret";
const OPERATOR = "op@example.com";

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

/**
 * T2.6 at the gateway: operator suspend takes effect within 5 seconds (INV9)
 * even though the gateway caches /internal/resolve for 30 s, and the invite
 * allowlist decides who may create an account.
 */
describe.runIf(Boolean(databaseUrl))("operator controls at the gateway (T2.6, INV9)", () => {
  let dbBundle: Db;
  let controlPlane: Awaited<ReturnType<typeof buildControlPlane>>;
  let gateway: GatewayInstance;
  let identity: FakeIdentityProvider;
  let mailer: MemoryMailer;
  let echo: Server;
  let echoPort: number;
  let operatorPat: string;
  let ownerId: string;
  let viewerId: string;
  let appId: string;
  const cache = new Map<string, ResolvedApp | null>();
  const upstreamSockets: net.Socket[] = [];

  const auth = authHost(BASE_DOMAIN);
  const host = appHost("board", "olive", BASE_DOMAIN);

  const admin = (url: string, payload?: Record<string, unknown>) =>
    controlPlane.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${operatorPat}` },
      ...(payload ? { payload } : {}),
    });

  async function visitAs(userId: string) {
    const s = await createSession(dbBundle.db, { userId, appHost: host });
    return () =>
      gateway.inject({
        method: "GET",
        url: "/",
        headers: { host, cookie: `${SESSION_COOKIE}=${s.id}` },
      });
  }

  /** GitHub sign-in through the auth host; returns the OAuth callback response. */
  async function githubSignIn(profile: {
    githubId: string;
    login: string;
    email: string;
    name: string;
  }) {
    const login = await gateway.inject({
      method: "GET",
      url: `/login/github?return_to=${encodeURIComponent(`http://${host}/`)}`,
      headers: { host: auth },
    });
    const state = new URL(login.headers.location!).searchParams.get("state")!;
    return gateway.inject({
      method: "POST",
      url: "/login/dev/callback",
      headers: { host: auth },
      payload: { code: identity.issueCodeFor(profile), state },
    });
  }

  /** Ask for a magic link; returns how many emails went out. */
  async function requestLink(email: string): Promise<number> {
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
        email,
        return_to: returnTo,
        csrf: hiddenInput(login.body, "csrf"),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // mail is sent without awaiting
    return mailer.sent.length;
  }

  /** POST a magic-link token to the verify endpoint (as the link's Continue button does). */
  async function verifyLink(token: string) {
    const page = await gateway.inject({
      method: "GET",
      url: `/login/email/verify?token=${encodeURIComponent(token)}`,
      headers: { host: auth },
    });
    return gateway.inject({
      method: "POST",
      url: "/login/email/verify",
      headers: {
        host: auth,
        cookie: cookieHeader(readSetCookies(page.headers["set-cookie"])),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ token, csrf: hiddenInput(page.body, "csrf") }).toString(),
    });
  }

  const userCount = async (email: string) =>
    (await dbBundle.db.select().from(schema.users).where(eq(schema.users.email, email))).length;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);

    echo = createServer((_req, res) => res.end("hello"));
    // Minimal WebSocket upstream: accept the upgrade and keep the socket open.
    echo.on("upgrade", (_req, socket: net.Socket) => {
      upstreamSockets.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const addr = echo.address();
    if (!addr || typeof addr === "string") throw new Error("no echo port");
    echoPort = addr.port;

    controlPlane = await buildControlPlane({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      internalToken: "operator-test-token",
      baseDomain: BASE_DOMAIN,
      operatorEmails: [OPERATOR],
    });
    await controlPlane.ready();

    // Like the production resolver: real /internal/resolve, cached (here for the whole run).
    const resolver: AppResolver = {
      async resolve(h) {
        if (cache.has(h)) return cache.get(h)!;
        const res = await controlPlane.inject({
          method: "POST",
          url: "/internal/resolve",
          headers: { "x-scad-internal-secret": INTERNAL_SECRET },
          payload: { host: h },
        });
        const value =
          res.statusCode === 404
            ? null
            : { ...(res.json() as ResolvedApp), upstreamHost: "127.0.0.1", port: echoPort };
        if (value) cache.set(h, value);
        return value;
      },
    };

    identity = new FakeIdentityProvider();
    mailer = new MemoryMailer();
    gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity,
      resolver,
      keys: await generateEphemeralIdentityKeys(),
      mailer,
      allowDevLogin: true,
      operatorEmails: [OPERATOR],
    });
    await gateway.ready();
  });

  beforeEach(async () => {
    cache.clear(); // each test recreates the app under a new id
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        invites, app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines,
        releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const [op, olive, vic] = await dbBundle.db
      .insert(schema.users)
      .values([
        { email: OPERATOR, handle: "op" },
        { email: "olive@example.com", handle: "olive" },
        { email: "vic@example.com", handle: "vic" },
      ])
      .returning();
    const pat = issuePat();
    await dbBundle.db
      .insert(schema.pats)
      .values({ userId: op!.id, tokenHash: pat.tokenHash, name: "t" });
    operatorPat = pat.token;
    ownerId = olive!.id;
    viewerId = vic!.id;
    const [a] = await dbBundle.db
      .insert(schema.apps)
      .values({ slug: "board", ownerId, status: "running" })
      .returning();
    appId = a!.id;
    await dbBundle.db
      .insert(schema.appAccess)
      .values({ appId, email: "vic@example.com", grantedBy: ownerId });
  });

  afterAll(async () => {
    for (const sock of upstreamSockets) sock.destroy();
    await gateway?.close();
    await controlPlane?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it("INV9: suspending an app blocks viewers and the owner at the gateway within 5 seconds", async () => {
    const asViewer = await visitAs(viewerId);
    const asOwner = await visitAs(ownerId);
    expect((await asViewer()).statusCode).toBe(200); // warms the resolve cache

    const t0 = Date.now();
    expect((await admin(`/v1/admin/apps/${appId}/suspend`)).statusCode).toBe(200);
    expect((await asViewer()).statusCode).toBe(403);
    expect((await asOwner()).statusCode).toBe(403);
    expect(Date.now() - t0).toBeLessThan(5000);

    expect((await admin(`/v1/admin/apps/${appId}/unsuspend`)).statusCode).toBe(200);
    expect((await asViewer()).statusCode).toBe(200);
  });

  it("INV9: suspending the owner blocks their app for viewers within 5 seconds", async () => {
    const asViewer = await visitAs(viewerId);
    expect((await asViewer()).statusCode).toBe(200);
    const t0 = Date.now();
    expect((await admin(`/v1/admin/users/${ownerId}/suspend`)).statusCode).toBe(200);
    expect((await asViewer()).statusCode).toBe(403);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("INV9: a suspended viewer loses access at once (sessions revoked)", async () => {
    const asViewer = await visitAs(viewerId);
    expect((await asViewer()).statusCode).toBe(200);
    expect((await admin(`/v1/admin/users/${viewerId}/suspend`)).statusCode).toBe(200);
    const res = await asViewer();
    // Session revoked: back to sign-in, which refuses suspended accounts.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`//${auth}/login`);
  });

  it("INV9: an open WebSocket is closed within 5 seconds of suspending its app", async () => {
    await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = (gateway.server.address() as net.AddressInfo).port;
    const s = await createSession(dbBundle.db, { userId: viewerId, appHost: host });
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    const upgraded = new Promise<string>((resolve) =>
      socket.once("data", (d) => resolve(d.toString())),
    );
    socket.write(
      `GET /ws HTTP/1.1\r\nHost: ${host}\r\nCookie: ${SESSION_COOKIE}=${s.id}\r\n` +
        "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    expect(await upgraded).toMatch(/^HTTP\/1\.1 101/);
    const upstream = upstreamSockets.at(-1)!;
    const upstreamEnded = new Promise<void>((resolve) => {
      upstream.once("end", resolve);
      upstream.once("close", resolve);
    });
    const closed = new Promise<number>((resolve) =>
      socket.once("close", () => resolve(Date.now())),
    );

    const t0 = Date.now();
    expect((await admin(`/v1/admin/apps/${appId}/suspend`)).statusCode).toBe(200);
    const at = await Promise.race([
      closed,
      new Promise<number>((r) => setTimeout(() => r(-1), 6000)),
    ]);
    expect(at).toBeGreaterThan(0);
    expect(at - t0).toBeLessThan(5000);
    // The gateway also lets go of the app side.
    await upstreamEnded;
  });

  it("an uninvited GitHub user is refused with a not-invited page and no account row", async () => {
    const res = await githubSignIn({
      githubId: "9001",
      login: "stranger",
      email: "stranger@example.com",
      name: "S",
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/not invited/i);
    expect(await userCount("stranger@example.com")).toBe(0);
  });

  it("an invited GitHub user gets in", async () => {
    expect((await admin("/v1/admin/invites", { email: "Newbie@Example.com" })).statusCode).toBe(
      201,
    );
    const res = await githubSignIn({
      githubId: "9002",
      login: "newbie",
      email: "newbie@example.com",
      name: "N",
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location!).host).toBe(host);
    expect(await userCount("newbie@example.com")).toBe(1);
  });

  it("a shared-to email and an OPERATOR_EMAILS address may create an account without an invite", async () => {
    await dbBundle.db
      .insert(schema.appAccess)
      .values({ appId, email: "friend@example.com", grantedBy: ownerId });
    const shared = await githubSignIn({
      githubId: "9003",
      login: "friend",
      email: "friend@example.com",
      name: "F",
    });
    expect(shared.statusCode).toBe(302);
    expect(await userCount("friend@example.com")).toBe(1);

    await dbBundle.db.delete(schema.pats);
    await dbBundle.db.delete(schema.users).where(eq(schema.users.email, OPERATOR));
    const op = await githubSignIn({ githubId: "9005", login: "op", email: OPERATOR, name: "Op" });
    expect(op.statusCode).toBe(302);
    expect(await userCount(OPERATOR)).toBe(1);
  });

  it("an existing account keeps access without an invite", async () => {
    // olive exists already: no invite, not shared, not an operator.
    const res = await githubSignIn({
      githubId: "9004",
      login: "olive-gh",
      email: "olive@example.com",
      name: "O",
    });
    expect(res.statusCode).toBe(302);
  });

  it("an uninvited email gets no link and no account row (same page as everyone)", async () => {
    expect(await requestLink("nobody@example.com")).toBe(0);
    expect(await userCount("nobody@example.com")).toBe(0);
  });

  it("an uninvited email holding a link sees not-invited and gets no account row", async () => {
    // E.g. an invite removed after the link was sent.
    const token = await createMagicLink(dbBundle.db, {
      email: "late@example.com",
      appHost: host,
      returnTo: `http://${host}/`,
      now: new Date(),
    });
    const res = await verifyLink(token);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/not invited/i);
    expect(await userCount("late@example.com")).toBe(0);
  });

  it("an invited email gets a link and an account on first sign-in", async () => {
    expect((await admin("/v1/admin/invites", { email: "pal@example.com" })).statusCode).toBe(201);
    expect(await requestLink("pal@example.com")).toBe(1);
    const link = new URL(/(http\S+verify\?token=\S+)/.exec(mailer.sent[0]!.text)![1]!);
    const res = await verifyLink(link.searchParams.get("token")!);
    expect(res.statusCode).toBe(302);
    expect(await userCount("pal@example.com")).toBe(1);
  });
});
