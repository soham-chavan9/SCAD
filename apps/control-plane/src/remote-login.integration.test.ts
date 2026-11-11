import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type AppInstance } from "./app.js";
import { issuePat } from "./auth/pat.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { apps, pats, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import type { MailMessage, Mailer } from "./lifecycle/jobs.js";

const databaseUrl = process.env["DATABASE_URL"];
const API = "https://api.scad.example.org";

class MemoryMailer implements Mailer {
  sent: MailMessage[] = [];
  fail = false;
  async send(message: MailMessage): Promise<void> {
    if (this.fail) throw new Error("smtp down");
    this.sent.push(message);
  }
}

/** T3.4: `scad login` from any machine (emailed approval) and share emails. */
describe.runIf(Boolean(databaseUrl))("remote login and share emails (T3.4)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let mailer: MemoryMailer;

  const start = (email?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/device",
      headers: { "content-type": "application/json", ...headers },
      payload: email ? { email } : {},
    });
  const poll = (deviceCode: string) =>
    app.inject({ method: "POST", url: "/v1/auth/device/token", payload: { device_code: deviceCode } });
  const linkFrom = (message: MailMessage | undefined) => {
    const m = /(https:\/\/\S+\/v1\/auth\/device\/email\?token=\S+)/.exec(message?.text ?? "");
    if (!m?.[1]) throw new Error("no approval link in the email");
    return new URL(m[1]);
  };
  const approve = (token: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/device/email",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.4" },
      payload: new URLSearchParams({ token }).toString(),
    });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
  });

  beforeEach(async () => {
    await app?.close();
    await dbBundle.db.execute(sql`TRUNCATE TABLE app_access, audit_events, machines, releases, pats, apps, users RESTART IDENTITY CASCADE`);
    mailer = new MemoryMailer();
    app = await buildApp({
      db: dbBundle.db,
      internalToken: "t",
      baseDomain: "scad.example.org",
      publicBaseUrl: API,
      operatorEmails: ["op@example.com"],
      mailer,
    });
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  it("an operator logs in from another machine by pressing Approve in an email", async () => {
    // Through the TLS front: forwarding headers, not loopback.
    const res = await start("Op@Example.com", { "x-forwarded-for": "198.51.100.4" });
    expect(res.statusCode).toBe(200);
    const device = res.json() as { device_code: string; user_code: string; approval: string; message: string };
    expect(device.approval).toBe("email");
    expect(device.message).toMatch(/approval link is on its way/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("op@example.com");
    expect(mailer.sent[0]?.subject).toContain(device.user_code.slice(0, 4));

    expect((await poll(device.device_code)).json()).toEqual({ error: "authorization_pending" });

    const link = linkFrom(mailer.sent[0]);
    expect(link.origin).toBe(API);
    // Opening the link (or a mail scanner fetching it) approves nothing.
    const page = await app.inject({ method: "GET", url: link.pathname + link.search });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`${device.user_code.slice(0, 4)}-${device.user_code.slice(4)}`);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect((await poll(device.device_code)).json()).toEqual({ error: "authorization_pending" });

    const token = link.searchParams.get("token")!;
    const ok = await approve(token);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatch(/Approved/);
    const done = (await poll(device.device_code)).json() as { pat: string };
    expect(done.pat).toMatch(/\S{20,}/);

    // The PAT works and belongs to the operator.
    const me = await app.inject({ method: "GET", url: "/v1/apps", headers: { authorization: `Bearer ${done.pat}` } });
    expect(me.statusCode).toBe(200);

    // Single use.
    expect((await approve(token)).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: link.pathname + link.search })).statusCode).toBe(410);
  });

  it("a non-operator email gets the same answer and no email", async () => {
    const res = await start("stranger@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approval: "email", message: expect.stringMatching(/If stranger@example.com may publish/) });
    expect(mailer.sent).toHaveLength(0);
  });

  it("a made-up or old link approves nothing", async () => {
    expect((await approve("not-a-token")).statusCode).toBe(410);
    expect((await approve("")).statusCode).toBe(410);
  });

  it("local approval still refuses anything that came through the TLS front", async () => {
    const device = (await start()).json() as { user_code: string };
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/device/approve",
      headers: { "x-forwarded-for": "127.0.0.1" },
      payload: { user_code: device.user_code, email: "op@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("limits approval emails per address", async () => {
    for (let i = 0; i < 5; i++) expect((await start("op@example.com")).statusCode).toBe(200);
    const res = await start("op@example.com");
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "RATE_LIMITED", hint: expect.stringMatching(/Wait 15 minutes/) });
    expect(mailer.sent).toHaveLength(5);
  });

  it("explains when the instance cannot send email", async () => {
    await app.close();
    app = await buildApp({ db: dbBundle.db, internalToken: "t", publicBaseUrl: API, operatorEmails: ["op@example.com"] });
    const res = await start("op@example.com");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ hint: expect.stringMatching(/SMTP_URL/) });
  });

  it("share emails the friend their link once", async () => {
    const [owner] = await dbBundle.db
      .insert(users)
      .values({ email: "olive@example.com", handle: "olive", displayName: "Olive" })
      .returning();
    if (!owner) throw new Error("insert failed");
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: owner.id, tokenHash: pat.tokenHash, name: "t" });
    await dbBundle.db.insert(apps).values({ slug: "my-site", ownerId: owner.id, status: "running" });
    const share = () =>
      app.inject({
        method: "POST",
        url: "/v1/apps/my-site/share",
        headers: { authorization: `Bearer ${pat.token}` },
        payload: { email: "Sam@Example.com" },
      });

    const first = await share();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ email: "sam@example.com", emailed: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: "sam@example.com", subject: "Olive (olive@example.com) shared a site with you" });
    expect(mailer.sent[0]?.text).toContain("https://my-site.olive.scad.example.org");

    const again = await share();
    expect(again.json()).toMatchObject({ emailed: false });
    expect(mailer.sent).toHaveLength(1);

    mailer.fail = true;
    const other = await app.inject({
      method: "POST",
      url: "/v1/apps/my-site/share",
      headers: { authorization: `Bearer ${pat.token}` },
      payload: { email: "kim@example.com" },
    });
    expect(other.statusCode).toBe(201);
    expect(other.json()).toMatchObject({ emailed: false });
  });
});
