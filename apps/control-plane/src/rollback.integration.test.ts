import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DeploySpec, MachineRef, MachineStatus, Reachable, RuntimeProvider } from "@scad/runtime-conformance";
import { buildApp, type AppInstance } from "./app.js";
import { issuePat } from "./auth/pat.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { apps, auditEvents, machines, pats, releases, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";

const databaseUrl = process.env["DATABASE_URL"];
const INTERNAL_TOKEN = "rollback-internal-token";
const INTERNAL_SECRET = "rollback-internal-secret";

class RecordingRuntime implements RuntimeProvider {
  deploys: DeploySpec[] = [];
  removals: { appId: string; deleteVolume: boolean }[] = [];
  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    this.deploys.push(spec);
    return { appId: spec.appId, providerId: `p-${this.deploys.length}` };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async status(): Promise<MachineStatus> {
    return "running";
  }
  async address(): Promise<Reachable> {
    return { host: "127.0.0.1", port: 1 };
  }
  // eslint-disable-next-line require-yield
  async *logs(): AsyncIterable<string> {
    return;
  }
  async remove(appId: string, opts: { deleteVolume: boolean }): Promise<void> {
    this.removals.push({ appId, deleteVolume: opts.deleteVolume });
  }
}

describe.runIf(Boolean(databaseUrl))("rollback (T3.6)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let runtime: RecordingRuntime;
  let ownerToken: string;
  let strangerToken: string;
  let appId: string;
  const releaseIds: Record<number, string> = {};

  async function userWithPat(email: string, handle: string): Promise<{ id: string; token: string }> {
    const [u] = await dbBundle.db.insert(users).values({ email, handle }).returning();
    if (!u) throw new Error("user insert failed");
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: u.id, tokenHash: pat.tokenHash, name: "t" });
    return { id: u.id, token: pat.token };
  }

  async function addRelease(version: number, status: "ready" | "failed" | "building") {
    const [r] = await dbBundle.db
      .insert(releases)
      .values({ appId, version, imageRef: `scad-apps/site:v${version}`, status, manifest: { port: 3000 + version } })
      .returning();
    if (!r) throw new Error("release insert failed");
    releaseIds[version] = r.id;
    return r;
  }

  const rollback = (token: string, idOrSlug = "site") =>
    app.inject({
      method: "POST",
      url: `/v1/apps/${idOrSlug}/rollback`,
      headers: { authorization: `Bearer ${token}` },
    });

  const resolvedPort = async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      headers: { "x-scad-internal-secret": INTERNAL_SECRET, "content-type": "application/json" },
      payload: { host: "site.owner.localhost:8080" },
    });
    return (res.json() as { port: number }).port;
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await app?.close();
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE env_vars, app_access, audit_events, machines, releases, pats, apps, users RESTART IDENTITY CASCADE
    `);
    const owner = await userWithPat("owner@example.com", "owner");
    ownerToken = owner.token;
    strangerToken = (await userWithPat("stranger@example.com", "stranger")).token;
    const [a] = await dbBundle.db.insert(apps).values({ slug: "site", ownerId: owner.id, status: "running" }).returning();
    if (!a) throw new Error("app insert failed");
    appId = a.id;
    await addRelease(1, "ready");
    await addRelease(2, "ready");
    await dbBundle.db.insert(machines).values({ appId, providerId: "p-0", state: "running" });
    runtime = new RecordingRuntime();
    app = await buildApp({
      db: dbBundle.db,
      internalToken: INTERNAL_TOKEN,
      internalSecret: INTERNAL_SECRET,
      baseDomain: "localhost:8080",
      masterKeys: { current: randomBytes(32), previous: [] },
      runtime,
    });
  });

  it("goes back to the previous release in one step and keeps /data", async () => {
    expect(await resolvedPort()).toBe(3002);
    const res = await rollback(ownerToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { release: { version: number }; previous: { version: number }; url: string; message: string };
    expect(body.release.version).toBe(1);
    expect(body.previous.version).toBe(2);
    expect(body.url).toBe("http://site.owner.localhost:8080");
    expect(body.message).toMatch(/version 2 to version 1/);

    expect(runtime.deploys.map((d) => d.imageRef)).toEqual(["scad-apps/site:v1"]);
    // The container is replaced; the /data volume is never removed.
    expect(runtime.removals).toEqual([]);
    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.currentReleaseId).toBe(releaseIds[1]);
    expect(await resolvedPort()).toBe(3001);
  });

  it("writes an audit row", async () => {
    await rollback(ownerToken);
    const events = await dbBundle.db.select().from(auditEvents).where(eq(auditEvents.action, "app.rollback"));
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ from_version: 2, to_version: 1 });
  });

  it("skips failed releases, and refuses when nothing earlier works", async () => {
    await addRelease(3, "failed");
    expect((await rollback(ownerToken)).json()).toMatchObject({ release: { version: 1 } });
    const again = await rollback(ownerToken);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "VALIDATION_FAILED", hint: expect.stringMatching(/publish again/) });
  });

  it("an env change after rollback redeploys the rolled-back release", async () => {
    await rollback(ownerToken);
    runtime.deploys = [];
    const res = await app.inject({
      method: "PUT",
      url: "/v1/apps/site/env",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { FOO: "bar" },
    });
    expect(res.statusCode).toBe(200);
    expect(runtime.deploys.map((d) => d.imageRef)).toEqual(["scad-apps/site:v1"]);
    expect(runtime.deploys[0]?.env["FOO"]).toBe("bar");
  });

  it("rollback deploys with the app's current env vars", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/apps/site/env",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { GREETING: "hi" },
    });
    runtime.deploys = [];
    await rollback(ownerToken);
    expect(runtime.deploys[0]?.env["GREETING"]).toBe("hi");
  });

  it("the next successful publish becomes current again", async () => {
    await rollback(ownerToken);
    const building = await addRelease(3, "building");
    const done = await app.inject({
      method: "POST",
      url: `/internal/builds/${building.id}/complete`,
      headers: { "x-scad-internal-token": INTERNAL_TOKEN, "content-type": "application/json" },
      payload: { ok: true, imageRef: "scad-apps/site:v3", providerId: "p-9" },
    });
    expect(done.statusCode).toBe(200);
    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.currentReleaseId).toBe(building.id);
    expect(await resolvedPort()).toBe(3003);
    // Going back from v3 lands on v2, the release before it.
    expect((await rollback(ownerToken)).json()).toMatchObject({ release: { version: 2 } });
  });

  it("is owner-only (INV10)", async () => {
    const res = await rollback(strangerToken);
    expect(res.statusCode).toBe(404);
    expect(runtime.deploys).toEqual([]);
  });

  it("refuses a suspended app", async () => {
    await dbBundle.db.update(apps).set({ status: "suspended" }).where(eq(apps.id, appId));
    const res = await rollback(ownerToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "APP_SUSPENDED" });
    expect(runtime.deploys).toEqual([]);
  });

  it("explains when the app has no working release", async () => {
    await dbBundle.db.update(releases).set({ status: "failed" }).where(eq(releases.appId, appId));
    const res = await rollback(ownerToken);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ hint: expect.stringMatching(/publish again/i) });
  });
});
