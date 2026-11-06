import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertTruncateAllowed,
  createDb,
  runMigrations,
  schema,
  type Db,
} from "@scad/control-plane";
import { FakeIdentityProvider } from "./auth/identity.js";
import { MAGIC_LINK_TTL_MS } from "./auth/magic-links.js";
import { buildGateway, type GatewayInstance } from "./app.js";
import { appHost, authHost } from "./host.js";
import { generateEphemeralIdentityKeys } from "./identity/keys.js";
import { MemoryMailer, SmtpMailer, type MailMessage } from "./mail/mailer.js";
import type { AppResolver } from "./resolve.js";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const MAILPIT_API = process.env["MAILPIT_API_URL"] ?? "http://localhost:8025";
const SMTP_URL = process.env["SMTP_URL"] ?? "smtp://localhost:1025";

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

function cookieHeader(cookies: Cookies): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function hiddenInput(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m?.[1]) throw new Error(`no hidden input ${name}`);
  return m[1].replaceAll("&amp;", "&");
}

function linkFrom(message: MailMessage): URL {
  const m = /(https?:\/\/\S+\/login\/email\/verify\?token=\S+)/.exec(message.text);
  if (!m?.[1]) throw new Error("no link in email");
  return new URL(m[1]);
}

describe.runIf(Boolean(databaseUrl))("magic-link sign-in (T1.1)", () => {
  let dbBundle: Db;
  let gateway: GatewayInstance;
  let echo: Server;
  let echoPort: number;
  let mailer: MemoryMailer;
  let clock: Date;
  let appId: string;

  const auth = authHost(BASE_DOMAIN);
  const host = appHost("notes", "carol", BASE_DOMAIN);
  const returnTo = `http://${host}/`;

  async function startLogin(ip = "10.0.0.1"): Promise<{ cookies: Cookies; csrf: string }> {
    const res = await gateway.inject({
      method: "GET",
      url: `/login?return_to=${encodeURIComponent(returnTo)}`,
      headers: { host: auth },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(200);
    const cookies = readSetCookies(res.headers["set-cookie"]);
    return { cookies, csrf: hiddenInput(res.body, "csrf") };
  }

  async function requestLink(email: string, ip = "10.0.0.1") {
    const { cookies, csrf } = await startLogin(ip);
    return gateway.inject({
      method: "POST",
      url: "/login/email",
      headers: {
        host: auth,
        cookie: cookieHeader(cookies),
        "content-type": "application/x-www-form-urlencoded",
      },
      remoteAddress: ip,
      payload: new URLSearchParams({ email, return_to: returnTo, csrf }).toString(),
    });
  }

  /** Open the emailed link, press Continue, return the response of the POST. */
  async function useLink(link: URL) {
    const page = await gateway.inject({
      method: "GET",
      url: link.pathname + link.search,
      headers: { host: auth },
    });
    expect(page.statusCode).toBe(200);
    const cookies = readSetCookies(page.headers["set-cookie"]);
    return gateway.inject({
      method: "POST",
      url: "/login/email/verify",
      headers: {
        host: auth,
        cookie: cookieHeader(cookies),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        token: hiddenInput(page.body, "token"),
        csrf: hiddenInput(page.body, "csrf"),
      }).toString(),
    });
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases,
        pats, apps, users
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

    const [carol] = await dbBundle.db
      .insert(schema.users)
      .values({ email: "carol@example.com", handle: "carol", displayName: "Carol" })
      .returning();
    if (!carol) throw new Error("insert failed");
    const [app] = await dbBundle.db
      .insert(schema.apps)
      .values({ slug: "notes", ownerId: carol.id, status: "running" })
      .returning();
    if (!app) throw new Error("insert failed");
    appId = app.id;

    const resolver: AppResolver = {
      async resolve(h) {
        if (h !== host) return null;
        return {
          appId,
          slug: "notes",
          status: "running",
          expiresAt: null,
          ownerId: carol.id,
          ownerHandle: "carol",
          ownerEmail: "carol@example.com",
          ownerStatus: "active",
          upstreamHost: "127.0.0.1",
          port: echoPort,
        };
      },
    };

    mailer = new MemoryMailer();
    clock = new Date();
    gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity: new FakeIdentityProvider(),
      resolver,
      keys: await generateEphemeralIdentityKeys(),
      mailer,
      now: () => clock,
    });
    await gateway.ready();
  });

  beforeEach(async () => {
    mailer.sent.length = 0;
    clock = new Date(clock.getTime() + 60 * 60 * 1000); // fresh rate-limit window per test
    await dbBundle.db.delete(schema.magicLinks);
  });

  afterAll(async () => {
    await gateway?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it("login page offers GitHub and email sign-in", async () => {
    const res = await gateway.inject({
      method: "GET",
      url: `/login?return_to=${encodeURIComponent(returnTo)}`,
      headers: { host: auth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("/login/github?return_to=");
    expect(res.body).toContain('action="/login/email"');
  });

  it("a link is emailed, works once, and signs the user in to the app", async () => {
    const res = await requestLink("Carol@Example.com");
    expect(res.statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("carol@example.com");
    const link = linkFrom(mailer.sent[0]!);
    expect(link.host).toBe(auth);

    const verified = await useLink(link);
    expect(verified.statusCode).toBe(302);
    const callback = new URL(verified.headers.location!);
    expect(callback.host).toBe(host);
    expect(callback.pathname).toBe("/__scad/callback");

    const exchanged = await gateway.inject({
      method: "GET",
      url: callback.pathname + callback.search,
      headers: { host },
    });
    expect(exchanged.statusCode).toBe(302);
    const session = readSetCookies(exchanged.headers["set-cookie"]);
    const page = await gateway.inject({
      method: "GET",
      url: "/",
      headers: { host, cookie: cookieHeader(session) },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ email: "carol@example.com" });

    const reused = await useLink(link);
    expect(reused.statusCode).toBe(400);
    expect(reused.headers.location).toBeUndefined();
  });

  it("opening the link (GET) does not consume it, so mail scanners cannot burn it", async () => {
    await requestLink("carol@example.com");
    const link = linkFrom(mailer.sent[0]!);
    for (let i = 0; i < 3; i++) {
      const page = await gateway.inject({
        method: "GET",
        url: link.pathname + link.search,
        headers: { host: auth },
      });
      expect(page.statusCode).toBe(200);
    }
    expect((await useLink(link)).statusCode).toBe(302);
  });

  it("expires after 10 minutes", async () => {
    await requestLink("carol@example.com");
    const link = linkFrom(mailer.sent[0]!);
    clock = new Date(clock.getTime() + MAGIC_LINK_TTL_MS + 1000);
    expect(MAGIC_LINK_TTL_MS).toBe(10 * 60 * 1000);
    const res = await useLink(link);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/expired/i);
  });

  it("stores only a hash of the token (INV5)", async () => {
    await requestLink("carol@example.com");
    const token = linkFrom(mailer.sent[0]!).searchParams.get("token")!;
    const rows = await dbBundle.db.select().from(schema.magicLinks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.appHost).toBe(host);
  });

  it("an unknown email gets the same response and no email (no account enumeration)", async () => {
    const known = await requestLink("carol@example.com", "10.0.1.1");
    const unknown = await requestLink("nobody@example.com", "10.0.1.2");
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    expect(mailer.sent.map((m) => m.to)).toEqual(["carol@example.com"]);
    const rows = await dbBundle.db
      .select()
      .from(schema.magicLinks)
      .where(eq(schema.magicLinks.email, "nobody@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("rate limits per email (known and unknown alike)", async () => {
    for (const email of ["carol@example.com", "ghost@example.com"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await requestLink(email, `10.1.0.${i}`)).statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    }
    expect(mailer.sent).toHaveLength(5);
  });

  it("rate limits per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await requestLink(`user${i}@example.com`, "10.2.0.1")).statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("rejects a POST without the CSRF cookie", async () => {
    const { csrf } = await startLogin();
    const res = await gateway.inject({
      method: "POST",
      url: "/login/email",
      headers: { host: auth, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ email: "carol@example.com", return_to: returnTo, csrf })
        .toString(),
    });
    expect(res.statusCode).toBe(403);
    expect(mailer.sent).toHaveLength(0);
  });

  it("rejects a return_to outside BASE_DOMAIN", async () => {
    const { cookies, csrf } = await startLogin();
    const res = await gateway.inject({
      method: "POST",
      url: "/login/email",
      headers: {
        host: auth,
        cookie: cookieHeader(cookies),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        email: "carol@example.com",
        return_to: "https://evil.example/",
        csrf,
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("SmtpMailer delivers to Mailpit (T1.1)", () => {
  async function mailpitUp(): Promise<boolean> {
    try {
      return (await fetch(`${MAILPIT_API}/api/v1/info`)).ok;
    } catch {
      return false;
    }
  }

  it("link email arrives in Mailpit", async () => {
    if (!(await mailpitUp())) {
      throw new Error(`Mailpit not reachable at ${MAILPIT_API}; run docker compose up -d mailpit`);
    }
    const to = `t11-${randomUUID().slice(0, 8)}@example.com`;
    const mailer = new SmtpMailer({ smtpUrl: SMTP_URL, from: "SCAD <no-reply@localhost>" });
    await mailer.send({ to, subject: "Sign in to SCAD", text: "http://auth.localhost:8080/x" });
    let found: { ID: string } | undefined;
    for (let i = 0; i < 20 && !found; i++) {
      const res = await fetch(
        `${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
      );
      const body = (await res.json()) as { messages: { ID: string }[] };
      found = body.messages[0];
      if (!found) await new Promise((r) => setTimeout(r, 100));
    }
    expect(found).toBeTruthy();
  });
});
