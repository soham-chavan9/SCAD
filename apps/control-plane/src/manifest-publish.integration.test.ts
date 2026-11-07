import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublishTarball } from "@scad/cli";
import { buildApp, type AppInstance } from "./app.js";
import { issuePat } from "./auth/pat.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { pats, releases, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";

const databaseUrl = process.env["DATABASE_URL"];

describe.runIf(Boolean(databaseUrl))("manifest handling on publish (T1.5)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let baseUrl: string;
  let workDir: string;
  let token: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const [user] = await dbBundle.db
      .insert(users)
      .values({ email: "m@example.com", handle: "mani" })
      .returning();
    if (!user) throw new Error("user insert failed");
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: user.id, tokenHash: pat.tokenHash, name: "t" });
    token = pat.token;

    workDir = await mkdtemp(join(tmpdir(), "scad-manifest-"));
    app = await buildApp({ db: dbBundle.db, dataDir: workDir, internalToken: "t" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await rm(workDir, { recursive: true, force: true });
  });

  async function publish(files: Record<string, string>, extra: { manifest?: unknown } = {}) {
    const dir = await mkdtemp(join(workDir, "fx-"));
    for (const [name, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), body);
    }
    const tarball = await createPublishTarball(dir);
    const form = new FormData();
    form.append("tarball", new Blob([new Uint8Array(tarball)]), "app.tar");
    form.append("name", "mani-app");
    if (extra.manifest !== undefined) form.append("manifest", JSON.stringify(extra.manifest));
    const res = await fetch(`${baseUrl}/v1/apps/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function storedManifest(body: Record<string, unknown>) {
    const releaseId = (body["release"] as { id: string }).id;
    const [row] = await dbBundle.db.select().from(releases).where(eq(releases.id, releaseId));
    return row?.manifest as Record<string, unknown>;
  }

  const dockerfile = "FROM scratch\n";

  it("reads scad.json from the tarball root and stores the resolved manifest", async () => {
    const res = await publish({
      Dockerfile: dockerfile,
      "scad.json": JSON.stringify({
        port: 3000,
        start: "node server.js --mode=manifest",
        env: { GREETING: "hi" },
        resources: { memory_mb: 256 },
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(await storedManifest(res.body)).toMatchObject({
      port: 3000,
      start: "node server.js --mode=manifest",
      env: { GREETING: "hi" },
      resources: { memory_mb: 256, disk_gb: 1 },
      frame_ancestors: "self",
    });
  });

  it("applies §11 defaults when there is no scad.json", async () => {
    const res = await publish({ Dockerfile: dockerfile });
    expect(res.status).toBe(202);
    expect(await storedManifest(res.body)).toEqual({
      port: 8080,
      env: {},
      egress: [],
      resources: { memory_mb: 512, disk_gb: 1 },
      frame_ancestors: "self",
    });
  });

  it("ignores scad.json files below the root", async () => {
    const res = await publish({
      Dockerfile: dockerfile,
      "sub/scad.json": JSON.stringify({ port: 1234 }),
    });
    expect(res.status).toBe(202);
    expect(await storedManifest(res.body)).toMatchObject({ port: 8080 });
  });

  it("returns MANIFEST_INVALID with a field-level hint for a bad field", async () => {
    const res = await publish({
      Dockerfile: dockerfile,
      "scad.json": JSON.stringify({ resources: { memory_mb: 4096 } }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "MANIFEST_INVALID" });
    expect(res.body["hint"]).toContain("resources.memory_mb");
    const details = res.body["details"] as { issues: { path: string; message: string }[] };
    expect(details.issues[0]?.path).toBe("resources.memory_mb");
  });

  it("returns MANIFEST_INVALID for an unknown key and for a bad port", async () => {
    const unknown = await publish({
      Dockerfile: dockerfile,
      "scad.json": JSON.stringify({ prot: 3000 }),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ code: "MANIFEST_INVALID" });
    expect(unknown.body["hint"]).toContain("prot");

    const port = await publish({
      Dockerfile: dockerfile,
      "scad.json": JSON.stringify({ port: 70000 }),
    });
    expect(port.status).toBe(400);
    expect(port.body["hint"]).toContain("port");
  });

  it("returns MANIFEST_INVALID when scad.json is not JSON", async () => {
    const res = await publish({ Dockerfile: dockerfile, "scad.json": "{ port: 3000 " });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "MANIFEST_INVALID" });
    expect(res.body["hint"]).toContain("scad.json");
  });

  it("an explicit manifest field takes precedence over scad.json", async () => {
    const res = await publish(
      { Dockerfile: dockerfile, "scad.json": JSON.stringify({ port: 3000 }) },
      { manifest: { port: 4000 } },
    );
    expect(res.status).toBe(202);
    expect(await storedManifest(res.body)).toMatchObject({ port: 4000 });
  });
});
