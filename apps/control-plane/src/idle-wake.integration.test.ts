import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  Reachable,
  RuntimeProvider,
} from "@scad/runtime-conformance";
import { buildApp } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { apps, machines, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { IDLE_STOP_MS, MachineController } from "./machines/controller.js";

const databaseUrl = process.env["DATABASE_URL"];
const INTERNAL_SECRET = "wake-test-secret";

/** Counts start/stop calls; start is slow so concurrent wakes overlap. */
class CountingRuntime implements RuntimeProvider {
  state = new Map<string, MachineStatus>();
  starts = 0;
  stops = 0;
  startDelayMs = 50;

  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    this.state.set(spec.appId, "running");
    return { appId: spec.appId, providerId: `p-${spec.appId}` };
  }
  async start(m: MachineRef): Promise<void> {
    this.starts += 1;
    await new Promise((r) => setTimeout(r, this.startDelayMs));
    this.state.set(m.appId, "running");
  }
  async stop(m: MachineRef): Promise<void> {
    this.stops += 1;
    this.state.set(m.appId, "stopped");
  }
  async status(m: MachineRef): Promise<MachineStatus> {
    return this.state.get(m.appId) ?? "missing";
  }
  async address(): Promise<Reachable> {
    return { host: "127.0.0.1", port: 1 };
  }
  // eslint-disable-next-line require-yield
  async *logs(): AsyncIterable<string> {
    return;
  }
  async remove(appId: string): Promise<void> {
    this.state.delete(appId);
  }
}

describe.runIf(Boolean(databaseUrl))("idle stop and wake (T1.4)", () => {
  let dbBundle: Db;
  let runtime: CountingRuntime;
  let ownerId: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
  });

  afterAll(async () => {
    await dbBundle?.client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    runtime = new CountingRuntime();
    const [owner] = await dbBundle.db
      .insert(users)
      .values({ email: "owner@example.com", handle: "owner" })
      .returning();
    if (!owner) throw new Error("owner insert failed");
    ownerId = owner.id;
  });

  async function seedApp(opts: {
    slug: string;
    state: "running" | "stopped";
    lastRequestAt: Date;
    pinned?: boolean;
    status?: "running" | "stopped" | "suspended";
  }): Promise<string> {
    const [app] = await dbBundle.db
      .insert(apps)
      .values({
        slug: opts.slug,
        ownerId,
        status: opts.status ?? opts.state,
        pinned: opts.pinned ?? false,
      })
      .returning();
    if (!app) throw new Error("app insert failed");
    await dbBundle.db.insert(machines).values({
      appId: app.id,
      providerId: `p-${app.id}`,
      state: opts.state,
      lastStartedAt: opts.lastRequestAt,
      lastRequestAt: opts.lastRequestAt,
    });
    runtime.state.set(app.id, opts.state);
    return app.id;
  }

  async function machine(appId: string) {
    const [row] = await dbBundle.db.select().from(machines).where(eq(machines.appId, appId));
    const [app] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    return { machine: row, app };
  }

  it("stops an app after 10 minutes without traffic", async () => {
    const now = new Date("2026-11-07T12:00:00Z");
    const idle = await seedApp({
      slug: "idle-app",
      state: "running",
      lastRequestAt: new Date(now.getTime() - IDLE_STOP_MS - 1000),
    });
    const busy = await seedApp({
      slug: "busy-app",
      state: "running",
      lastRequestAt: new Date(now.getTime() - 60_000),
    });
    const controller = new MachineController({ db: dbBundle.db, runtime, now: () => now });

    const stopped = await controller.stopIdle();

    expect(stopped).toEqual([idle]);
    expect(runtime.stops).toBe(1);
    expect(runtime.state.get(idle)).toBe("stopped");
    expect(runtime.state.get(busy)).toBe("running");
    const row = await machine(idle);
    expect(row.machine?.state).toBe("stopped");
    expect(row.app?.status).toBe("stopped");
  });

  it("never stops a pinned app", async () => {
    const now = new Date("2026-11-07T12:00:00Z");
    const pinned = await seedApp({
      slug: "pinned-app",
      state: "running",
      pinned: true,
      lastRequestAt: new Date(now.getTime() - 24 * 60 * 60_000),
    });
    const controller = new MachineController({ db: dbBundle.db, runtime, now: () => now });

    expect(await controller.stopIdle()).toEqual([]);
    expect(runtime.state.get(pinned)).toBe("running");
  });

  it("a wake storm of 50 concurrent requests causes exactly one start", async () => {
    const appId = await seedApp({
      slug: "storm-app",
      state: "stopped",
      lastRequestAt: new Date(Date.now() - IDLE_STOP_MS * 2),
    });
    const cp = await buildApp({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      internalToken: "t",
      runtime,
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          cp.inject({
            method: "POST",
            url: "/internal/wake",
            headers: { "x-scad-internal-secret": INTERNAL_SECRET },
            payload: { appId },
          }),
        ),
      );
      for (const res of results) {
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ state: "running" });
      }
      expect(runtime.starts).toBe(1);
      const row = await machine(appId);
      expect(row.machine?.state).toBe("running");
      expect(row.app?.status).toBe("running");

      // Already running: wake is a no-op.
      const again = await cp.inject({
        method: "POST",
        url: "/internal/wake",
        headers: { "x-scad-internal-secret": INTERNAL_SECRET },
        payload: { appId },
      });
      expect(again.statusCode).toBe(200);
      expect(runtime.starts).toBe(1);
    } finally {
      await cp.close();
    }
  });

  it("wake requires the internal secret and refuses suspended apps", async () => {
    const appId = await seedApp({
      slug: "susp-app",
      state: "stopped",
      status: "suspended",
      lastRequestAt: new Date(),
    });
    const cp = await buildApp({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      internalToken: "t",
      runtime,
    });
    try {
      const noSecret = await cp.inject({
        method: "POST",
        url: "/internal/wake",
        payload: { appId },
      });
      expect(noSecret.statusCode).toBe(401);

      const suspended = await cp.inject({
        method: "POST",
        url: "/internal/wake",
        headers: { "x-scad-internal-secret": INTERNAL_SECRET },
        payload: { appId },
      });
      expect(suspended.statusCode).toBe(403);
      expect(suspended.json()).toMatchObject({ code: "APP_SUSPENDED" });
      expect(runtime.starts).toBe(0);

      const bad = await cp.inject({
        method: "POST",
        url: "/internal/wake",
        headers: { "x-scad-internal-secret": INTERNAL_SECRET },
        payload: { appId: "not-a-uuid" },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await cp.close();
    }
  });

  it("touch records the last request so a viewed app is not stopped", async () => {
    const start = new Date("2026-11-07T12:00:00Z");
    let clock = start;
    const appId = await seedApp({
      slug: "touch-app",
      state: "running",
      lastRequestAt: new Date(start.getTime() - IDLE_STOP_MS + 60_000),
    });
    const cp = await buildApp({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      internalToken: "t",
      runtime,
      now: () => clock,
    });
    try {
      const touched = await cp.inject({
        method: "POST",
        url: "/internal/touch",
        headers: { "x-scad-internal-secret": INTERNAL_SECRET },
        payload: { appId, userId: ownerId },
      });
      expect(touched.statusCode, touched.body).toBe(200);

      clock = new Date(start.getTime() + 5 * 60_000);
      const controller = new MachineController({ db: dbBundle.db, runtime, now: () => clock });
      expect(await controller.stopIdle()).toEqual([]);

      clock = new Date(start.getTime() + IDLE_STOP_MS + 1000);
      expect(await controller.stopIdle()).toEqual([appId]);
      const row = await machine(appId);
      expect(row.machine?.lastRequestAt?.toISOString()).toBe(start.toISOString());
      expect(row.app?.lastViewedAt?.toISOString()).toBe(start.toISOString());
    } finally {
      await cp.close();
    }
  });
});
