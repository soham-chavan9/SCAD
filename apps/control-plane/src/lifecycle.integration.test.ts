import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DeploySpec, MachineRef, RuntimeProvider } from "@scad/runtime-conformance";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { appAccess, apps, auditEvents, envVars, machines, usageDaily, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { LifecycleJobs, type Mailer } from "./lifecycle/jobs.js";
import { MachineController } from "./machines/controller.js";

const databaseUrl = process.env["DATABASE_URL"];
const DAY = 24 * 60 * 60 * 1000;

/** In-memory runtime: records calls, and can report extra (orphan) apps. */
class FakeRuntime implements RuntimeProvider {
  readonly calls: string[] = [];
  readonly state = new Map<string, "running" | "stopped">();
  extraApps: { appId: string; resources: string[] }[] = [];
  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    this.state.set(spec.appId, "running");
    return { appId: spec.appId, providerId: `c-${spec.appId}` };
  }
  async start(m: MachineRef): Promise<void> {
    this.calls.push(`start:${m.appId}`);
    this.state.set(m.appId, "running");
  }
  async stop(m: MachineRef): Promise<void> {
    this.calls.push(`stop:${m.appId}`);
    this.state.set(m.appId, "stopped");
  }
  async status(m: MachineRef) {
    return this.state.get(m.appId) ?? "missing";
  }
  async address() {
    return { host: "127.0.0.1", port: 1 };
  }
  async *logs(): AsyncIterable<string> {}
  async remove(appId: string, opts: { deleteVolume: boolean }): Promise<void> {
    this.calls.push(`remove:${appId}:${opts.deleteVolume}`);
    this.state.delete(appId);
  }
  async listApps() {
    return [
      ...[...this.state.keys()].map((appId) => ({ appId, resources: ["container"] })),
      ...this.extraApps,
    ];
  }
}

describe.runIf(Boolean(databaseUrl))("lifecycle jobs with a fake clock (T2.5)", () => {
  let dbBundle: Db;
  let clock: Date;
  let runtime: FakeRuntime;
  let mail: { to: string; subject: string; text: string }[];
  let jobs: LifecycleJobs;
  let controller: MachineController;
  let ownerId: string;
  let viewerId: string;
  const t0 = new Date("2026-01-01T00:00:00Z");
  const advanceTo = (ms: number) => {
    clock = new Date(t0.getTime() + ms);
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
  });

  beforeEach(async () => {
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        usage_viewers, usage_daily, app_access, env_vars, runtime_logs, magic_links, oauth_states, login_codes,
        sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    clock = t0;
    runtime = new FakeRuntime();
    mail = [];
    const mailer: Mailer = { send: async (m) => void mail.push(m) };
    const now = () => clock;
    controller = new MachineController({ db: dbBundle.db, runtime, now });
    jobs = new LifecycleJobs({ db: dbBundle.db, machines: controller, inventory: runtime, mailer, baseDomain: "localhost:8080", now });
    const [owner] = await dbBundle.db.insert(users).values({ email: "own@example.com", handle: "own" }).returning();
    const [viewer] = await dbBundle.db.insert(users).values({ email: "v@example.com", handle: "vee" }).returning();
    ownerId = owner!.id;
    viewerId = viewer!.id;
  });

  afterAll(async () => {
    await dbBundle?.client.end({ timeout: 5 });
  });

  /** A published, running app whose 30-day clock starts at t0. */
  async function liveApp(slug: string, opts: { pinned?: boolean } = {}) {
    const [row] = await dbBundle.db
      .insert(apps)
      .values({
        slug,
        ownerId,
        status: "running",
        pinned: opts.pinned ?? false,
        expiresAt: new Date(t0.getTime() + 30 * DAY),
      })
      .returning();
    const id = row!.id;
    await dbBundle.db.insert(machines).values({ appId: id, providerId: `c-${id}`, volumeRef: `v-${id}`, state: "running" });
    runtime.state.set(id, "running");
    await dbBundle.db.insert(appAccess).values({ appId: id, email: "v@example.com", grantedBy: ownerId });
    return id;
  }
  const appRow = async (id: string) => (await dbBundle.db.select().from(apps).where(eq(apps.id, id)))[0]!;
  const audit = async (id: string) =>
    (await dbBundle.db.select().from(auditEvents).where(eq(auditEvents.appId, id))).map((r) => r.action);

  it("walks an unviewed app through warn, stop, grace, and delete", async () => {
    const id = await liveApp("forgotten");

    advanceTo(22 * DAY);
    expect(await jobs.notifyExpiring()).toEqual([]);

    advanceTo(23 * DAY + 60_000); // inside the 7-day warning window
    expect(await jobs.notifyExpiring()).toEqual([id]);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: "own@example.com" });
    expect(mail[0]!.text).toContain("http://forgotten.own.localhost:8080");
    expect(mail[0]!.text).toContain("2026-01-31");
    expect(await jobs.notifyExpiring()).toEqual([]); // once per expiry, not every run
    expect(mail).toHaveLength(1);

    advanceTo(30 * DAY - 60_000);
    expect(await jobs.expire()).toEqual([]);
    advanceTo(30 * DAY);
    expect(await jobs.expire()).toEqual([id]);
    expect((await appRow(id)).status).toBe("expired");
    expect(runtime.calls).toContain(`stop:${id}`);

    advanceTo(44 * DAY - 60_000); // still inside the 14-day grace period
    expect(await jobs.deleteExpired()).toEqual([]);
    expect(runtime.calls.some((c) => c.startsWith("remove:"))).toBe(false);

    advanceTo(44 * DAY);
    expect(await jobs.deleteExpired()).toEqual([id]);
    expect((await appRow(id)).status).toBe("deleted");
    expect(runtime.calls).toContain(`remove:${id}:true`);
    expect(await dbBundle.db.select().from(appAccess).where(eq(appAccess.appId, id))).toHaveLength(0);
    expect(await dbBundle.db.select().from(envVars).where(eq(envVars.appId, id))).toHaveLength(0);
    expect(await audit(id)).toEqual(
      expect.arrayContaining(["app.expiry_warning", "app.expire", "app.delete"]),
    );
  });

  it("viewing renews expiry to 30 days from the view and re-arms the warning", async () => {
    const id = await liveApp("busy");
    advanceTo(24 * DAY);
    expect(await jobs.notifyExpiring()).toEqual([id]);

    advanceTo(25 * DAY);
    await controller.touch(id, viewerId);
    const row = await appRow(id);
    expect(row.expiresAt?.toISOString()).toBe(new Date(t0.getTime() + 55 * DAY).toISOString());
    expect(row.lastViewedAt?.toISOString()).toBe(clock.toISOString());

    advanceTo(31 * DAY);
    expect(await jobs.expire()).toEqual([]);
    expect((await appRow(id)).status).toBe("running");

    advanceTo(49 * DAY); // 6 days before the renewed expiry: warns again
    expect(await jobs.notifyExpiring()).toEqual([id]);
    expect(mail).toHaveLength(2);
  });

  it("pinned apps never warn, expire, or get deleted", async () => {
    const id = await liveApp("keeper", { pinned: true });
    advanceTo(100 * DAY);
    expect(await jobs.notifyExpiring()).toEqual([]);
    expect(await jobs.expire()).toEqual([]);
    expect(await jobs.deleteExpired()).toEqual([]);
    expect((await appRow(id)).status).toBe("running");
  });

  it("an expired app is not renewed by a late touch", async () => {
    const id = await liveApp("late");
    advanceTo(30 * DAY);
    await jobs.expire();
    advanceTo(31 * DAY);
    await controller.touch(id, viewerId);
    expect((await appRow(id)).expiresAt?.toISOString()).toBe(new Date(t0.getTime() + 30 * DAY).toISOString());
  });

  it("reaper flags a runtime app with no DB row, and a DB machine with no runtime container", async () => {
    const known = await liveApp("known");
    const gone = await liveApp("gone");
    runtime.state.delete(gone);
    runtime.extraApps = [{ appId: "11111111-1111-4111-8111-111111111111", resources: ["container", "network"] }];

    const report = await jobs.reapOrphans();
    expect(report.orphans).toEqual([
      { appId: "11111111-1111-4111-8111-111111111111", resources: ["container", "network"] },
    ]);
    expect(report.missing).toEqual([gone]);
    expect(report.orphans.map((o) => o.appId)).not.toContain(known);
    const [m] = await dbBundle.db.select().from(machines).where(eq(machines.appId, gone));
    expect(m?.state).toBe("missing");
    const flagged = await dbBundle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "runtime.orphan"));
    expect(flagged).toHaveLength(1);
  });

  it("usage roll-up turns touches into daily requests and unique viewers", async () => {
    const id = await liveApp("counted");
    advanceTo(2 * 60 * 60 * 1000);
    await controller.touch(id, viewerId);
    await controller.touch(id, viewerId);
    await controller.touch(id, ownerId);
    advanceTo(DAY + 60_000);
    await controller.touch(id, viewerId);

    await jobs.rollupUsage();
    const rows = await dbBundle.db
      .select()
      .from(usageDaily)
      .where(and(eq(usageDaily.appId, id)))
      .orderBy(usageDaily.day);
    expect(rows.map((r) => ({ day: r.day, requests: r.requests, unique: r.uniqueViewers }))).toEqual([
      { day: "2026-01-01", requests: 3, unique: 2 },
      { day: "2026-01-02", requests: 1, unique: 1 },
    ]);
    // Idempotent: running it again does not double count.
    await jobs.rollupUsage();
    const again = await dbBundle.db.select().from(usageDaily).where(eq(usageDaily.appId, id));
    expect(again.reduce((n, r) => n + r.requests, 0)).toBe(4);
  });
});
