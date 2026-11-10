import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  ManagedRuntime,
  Reachable,
} from "@scad/runtime-conformance";
import { buildApp, type AppInstance } from "./app.js";
import { issuePat } from "./auth/pat.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { apps, machines, pats, usageViewers, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { MachineController } from "./machines/controller.js";

const databaseUrl = process.env["DATABASE_URL"];
const HOUR = 3_600_000;

/** In-memory runtime with the optional volume capabilities. */
class UsageRuntime implements ManagedRuntime {
  state: MachineStatus = "running";
  volumes = new Map<string, number>();
  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    return { appId: spec.appId, providerId: `p-${spec.appId}` };
  }
  async start(): Promise<void> {
    this.state = "running";
  }
  async stop(): Promise<void> {
    this.state = "stopped";
  }
  async status(): Promise<MachineStatus> {
    return this.state;
  }
  async address(): Promise<Reachable> {
    return { host: "127.0.0.1", port: 1 };
  }
  async *logs(): AsyncIterable<string> {}
  async remove(): Promise<void> {}
  async volumeUsage(appId: string) {
    return { usedBytes: this.volumes.get(appId) ?? 0, limitBytes: 1024 ** 3 };
  }
  async enforceVolumeQuota(): Promise<"ok" | "stopped"> {
    return "ok";
  }
}

/** T2.7: `scad admin usage` data and the operator page. */
describe.runIf(Boolean(databaseUrl))("usage and cost visibility (T2.7)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let runtime: UsageRuntime;
  let controller: MachineController;
  let clock: Date;
  let operatorToken: string;
  let memberToken: string;
  let appId: string;
  let viewerIds: string[];

  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  const usage = async (token: string, query = "") =>
    app.inject({
      method: "GET",
      url: `/v1/admin/usage${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

  async function userWithPat(email: string, handle: string) {
    const [u] = await dbBundle.db.insert(users).values({ email, handle }).returning();
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: u!.id, tokenHash: pat.tokenHash, name: "t" });
    return { id: u!.id, token: pat.token };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    runtime = new UsageRuntime();
    controller = new MachineController({ db: dbBundle.db, runtime, now: () => clock });
    app = await buildApp({
      db: dbBundle.db,
      internalToken: "t",
      operatorEmails: ["op@example.com"],
      runtime,
      machines: controller,
      now: () => clock,
    });
  });

  beforeEach(async () => {
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        invites, usage_viewers, usage_daily, runtime_logs, env_vars, app_access, sessions,
        audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    clock = new Date("2026-11-10T12:00:00Z");
    runtime.state = "running";
    operatorToken = (await userWithPat("op@example.com", "op")).token;
    const member = await userWithPat("olive@example.com", "olive");
    memberToken = member.token;
    const [a] = await dbBundle.db
      .insert(apps)
      .values({ slug: "board", ownerId: member.id, status: "running" })
      .returning();
    appId = a!.id;
    await dbBundle.db
      .insert(machines)
      .values({ appId, providerId: `p-${appId}`, state: "running", lastStartedAt: clock });
    viewerIds = [];
    for (const n of [1, 2]) {
      const [v] = await dbBundle.db
        .insert(users)
        .values({ email: `v${n}@example.com`, handle: `v${n}` })
        .returning();
      viewerIds.push(v!.id);
    }
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  it("non-operators get 403", async () => {
    const res = await usage(memberToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("shows requests, unique viewers, and last viewed from gateway touches", async () => {
    await controller.touch(appId, viewerIds[0], 3);
    await controller.touch(appId, viewerIds[1]);
    advance(60_000);
    await controller.touch(appId, viewerIds[0]);
    const res = await usage(operatorToken);
    expect(res.statusCode).toBe(200);
    const [row] = res.json().apps;
    expect(row).toMatchObject({
      id: appId,
      owner: "olive",
      slug: "board",
      requests: 5,
      unique_viewers: 2,
      last_viewed_at: clock.toISOString(),
    });
    expect(res.json().totals).toMatchObject({ apps: 1, requests: 5 });
  });

  it("the window excludes older traffic", async () => {
    const old = new Date(clock.getTime() - 3 * 24 * HOUR).toISOString().slice(0, 10);
    await dbBundle.db
      .insert(usageViewers)
      .values({ appId, day: old, userId: viewerIds[0]!, requests: 7 });
    await controller.touch(appId, viewerIds[1]);
    expect((await usage(operatorToken)).json().apps[0]).toMatchObject({
      requests: 8,
      unique_viewers: 2,
    });
    expect((await usage(operatorToken, "?days=1")).json().apps[0]).toMatchObject({
      requests: 1,
      unique_viewers: 1,
    });
    expect((await usage(operatorToken, "?days=99")).statusCode).toBe(400);
  });

  it("running hours add up across stop and wake, and include the current run", async () => {
    advance(2 * HOUR);
    await controller.stop(appId);
    advance(5 * HOUR); // stopped time does not count
    await controller.wake(appId);
    advance(HOUR / 2);
    expect((await usage(operatorToken)).json().apps[0].running_hours).toBe(2.5);
    await controller.stop(appId);
    advance(HOUR);
    expect((await usage(operatorToken)).json().apps[0].running_hours).toBe(2.5);
    const [m] = await dbBundle.db.select().from(machines).where(eq(machines.appId, appId));
    expect(m?.runningSeconds).toBe(9000);
  });

  it("the quota sweep records each running app's volume size", async () => {
    runtime.volumes.set(appId, 5 * 1024 * 1024);
    await controller.enforceVolumeQuotas();
    const [row] = (await usage(operatorToken)).json().apps;
    expect(row).toMatchObject({
      volume_bytes: 5 * 1024 * 1024,
      volume_measured_at: clock.toISOString(),
    });
  });

  it("serves a static operator page: no data, strict CSP pinned to its script", async () => {
    const res = await app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("/v1/admin/usage");
    expect(res.body).not.toContain("olive");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    const script = /<script>([\s\S]*)<\/script>/.exec(res.body)![1]!;
    const hash = createHash("sha256").update(script).digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
