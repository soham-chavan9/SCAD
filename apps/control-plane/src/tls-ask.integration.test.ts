import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildApp, defaultPublicBaseUrl, type AppInstance } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { apps, users } from "./db/schema.js";

const databaseUrl = process.env["DATABASE_URL"];
const BASE = "scad.example.org";

describe("defaultPublicBaseUrl (T3.1)", () => {
  it("is api.{BASE_DOMAIN} over https on a real domain", () => {
    expect(defaultPublicBaseUrl(BASE)).toBe(`https://api.${BASE}`);
  });
  it("stays the direct control-plane URL on localhost", () => {
    expect(defaultPublicBaseUrl("localhost:8080")).toBe("http://127.0.0.1:4000");
  });
});

describe.runIf(Boolean(databaseUrl))("Caddy on-demand TLS ask endpoint (T3.1)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let dataDir: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    dataDir = await mkdtemp(join(tmpdir(), "scad-tls-ask-"));
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(
      sql`TRUNCATE TABLE audit_events, machines, releases, pats, apps, users RESTART IDENTITY CASCADE`,
    );
    const [owner] = await dbBundle.db
      .insert(users)
      .values({ email: "tls-owner@example.com", displayName: "", handle: "tlsowner", role: "member", status: "active" })
      .returning();
    if (!owner) throw new Error("user insert failed");
    await dbBundle.db.insert(apps).values([
      { slug: "live-site", ownerId: owner.id, status: "running" },
      { slug: "asleep-site", ownerId: owner.id, status: "stopped" },
      { slug: "gone-site", ownerId: owner.id, status: "deleted" },
    ]);
    app = await buildApp({ db: dbBundle.db, dataDir, baseDomain: BASE, internalToken: "t" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const ask = (domain: string) =>
    app.inject({ method: "GET", url: `/internal/tls-ask?domain=${encodeURIComponent(domain)}` });

  it("allows the auth and api hosts", async () => {
    expect((await ask(`auth.${BASE}`)).statusCode).toBe(200);
    expect((await ask(`api.${BASE}`)).statusCode).toBe(200);
    expect((await ask(`API.${BASE}.`)).statusCode).toBe(200);
  });

  it("allows hosts of apps that exist, running or asleep", async () => {
    expect((await ask(`live-site.tlsowner.${BASE}`)).statusCode).toBe(200);
    expect((await ask(`asleep-site.tlsowner.${BASE}`)).statusCode).toBe(200);
  });

  it.each([
    [`nope-site.tlsowner.${BASE}`, "unknown app"],
    [`live-site.someoneelse.${BASE}`, "wrong owner"],
    [`gone-site.tlsowner.${BASE}`, "deleted app"],
    [BASE, "apex"],
    [`www.${BASE}`, "one-level name"],
    [`a.b.c.${BASE}`, "three-level name"],
    ["evil.example.com", "foreign domain"],
    [`live-site.tlsowner.${BASE}.evil.com`, "suffix trick"],
    [`LIVE_SITE.tlsowner.${BASE}`, "invalid slug"],
  ])("refuses %s (%s)", async (domain) => {
    expect((await ask(domain)).statusCode).not.toBe(200);
  });

  it("refuses a missing domain", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/tls-ask" });
    expect(res.statusCode).toBe(400);
  });
});
