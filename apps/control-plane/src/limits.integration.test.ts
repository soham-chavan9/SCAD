import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublishTarball } from "@scad/cli";
import { buildApp, type AppInstance } from "./app.js";
import { issuePat } from "./auth/pat.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { apps, pats, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";

const databaseUrl = process.env["DATABASE_URL"];

/** T2.3: every platform limit answers with the right §8 code and a useful hint. */
describe.runIf(Boolean(databaseUrl))("limits and quotas on publish (T2.3)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let baseUrl: string;
  let workDir: string;
  let token: string;
  let userId: string;
  let tarball: Buffer;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    workDir = await mkdtemp(join(tmpdir(), "scad-limits-"));
    const src = await mkdtemp(join(workDir, "src-"));
    await writeFile(join(src, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
    tarball = await createPublishTarball(src);
    app = await buildApp({ db: dbBundle.db, dataDir: workDir, internalToken: "t" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(async () => {
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const [user] = await dbBundle.db
      .insert(users)
      .values({ email: "lim@example.com", handle: "lim" })
      .returning();
    if (!user) throw new Error("user insert failed");
    userId = user.id;
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: user.id, tokenHash: pat.tokenHash, name: "t" });
    token = pat.token;
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await rm(workDir, { recursive: true, force: true });
  });

  async function publish(opts: { name: string; body?: Buffer; manifest?: unknown }) {
    const form = new FormData();
    form.append("tarball", new Blob([new Uint8Array(opts.body ?? tarball)]), "app.tar");
    form.append("name", opts.name);
    if (opts.manifest !== undefined) form.append("manifest", JSON.stringify(opts.manifest));
    const res = await fetch(`${baseUrl}/v1/apps/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function seedApps(n: number, status: "running" | "stopped" | "deleted" | "expired" = "running") {
    for (let i = 0; i < n; i++) {
      await dbBundle.db.insert(apps).values({ slug: `seed-${status}-${i}`, ownerId: userId, status });
    }
  }

  it("the 11th live app is refused with LIMIT_EXCEEDED and a hint", async () => {
    await seedApps(10);
    const res = await publish({ name: "eleventh" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "LIMIT_EXCEEDED",
      hint: expect.stringMatching(/delete/i),
      details: { live_apps: 10, max_live_apps: 10 },
    });
  });

  it("republishing an existing app at the cap still works", async () => {
    await seedApps(10);
    const res = await publish({ name: "seed-running-3" });
    expect(res.status).toBe(202);
  });

  it("deleted and expired apps do not count toward the cap", async () => {
    await seedApps(9);
    await seedApps(3, "deleted");
    await seedApps(3, "expired");
    expect((await publish({ name: "tenth" })).status).toBe(202);
    expect((await publish({ name: "eleventh" })).body).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("a 101 MB upload is refused with UPLOAD_TOO_LARGE and a hint", async () => {
    const big = Buffer.alloc(101 * 1024 * 1024, 7);
    const res = await publish({ name: "too-big", body: big });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      code: "UPLOAD_TOO_LARGE",
      hint: expect.stringContaining("100 MB"),
    });
  }, 60_000);

  it("an over-cap memory request is refused with LIMIT_EXCEEDED naming the cap", async () => {
    const res = await publish({ name: "hungry", manifest: { resources: { memory_mb: 4096 } } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "LIMIT_EXCEEDED",
      hint: expect.stringContaining("1024"),
    });
    const details = res.body["details"] as { issues: { path: string }[] };
    expect(details.issues[0]?.path).toBe("resources.memory_mb");
  });

  it("an over-cap disk request is refused with LIMIT_EXCEEDED naming the cap", async () => {
    const res = await publish({ name: "hoarder", manifest: { resources: { disk_gb: 50 } } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED", hint: expect.stringContaining("5") });
  });
});
