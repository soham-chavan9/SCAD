import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { formatAppUrl, isUuid } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, auditEvents, machines, usageDaily, usageViewers, users } from "../db/schema.js";
import type { MachineController } from "../machines/controller.js";
import { EXPIRY_GRACE_MS, EXPIRY_WARNING_MS, utcDay } from "./policy.js";
import { deleteApp } from "./delete.js";

export type MailMessage = { to: string; subject: string; text: string };
export type Mailer = { send(message: MailMessage): Promise<void> };

/** What the runtime actually has, per app (Docker: containers, networks, volumes). */
export type RuntimeInventory = {
  listApps(): Promise<{ appId: string; resources: string[] }[]>;
};

export type ReapReport = {
  /** Runtime resources for apps with no live DB row. Flagged, not removed. */
  orphans: { appId: string; resources: string[] }[];
  /** Apps the DB thinks have a machine, but the runtime has nothing for. */
  missing: string[];
};

export type LifecycleJobsOpts = {
  db: Db["db"];
  machines: MachineController;
  mailer: Mailer;
  baseDomain: string;
  inventory?: RuntimeInventory;
  now?: () => Date;
};

/** Keep raw per-viewer rows long enough for 30-day viewer counts. */
const USAGE_VIEWERS_RETENTION_DAYS = 35;
/** Statuses that are still "live" for expiry purposes. */
const EXPIRABLE = ["running", "stopped"] as const;

/**
 * T2.5 lifecycle jobs. Every method is idempotent and safe to run on any
 * schedule; `startLifecycleJobs` sets the cadence. Pinned apps are exempt
 * from warning, expiry, and deletion.
 */
export class LifecycleJobs {
  readonly #db: Db["db"];
  readonly #machines: MachineController;
  readonly #mailer: Mailer;
  readonly #baseDomain: string;
  readonly #inventory: RuntimeInventory | undefined;
  readonly #now: () => Date;

  constructor(opts: LifecycleJobsOpts) {
    this.#db = opts.db;
    this.#machines = opts.machines;
    this.#mailer = opts.mailer;
    this.#baseDomain = opts.baseDomain;
    this.#inventory = opts.inventory;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Email owners once when their app is within 7 days of expiring. Returns warned app ids. */
  async notifyExpiring(): Promise<string[]> {
    const now = this.#now();
    const horizon = new Date(now.getTime() + EXPIRY_WARNING_MS);
    const due = await this.#db
      .select({
        id: apps.id,
        slug: apps.slug,
        expiresAt: apps.expiresAt,
        email: users.email,
        handle: users.handle,
      })
      .from(apps)
      .innerJoin(users, eq(users.id, apps.ownerId))
      .where(
        and(
          inArray(apps.status, [...EXPIRABLE]),
          eq(apps.pinned, false),
          isNull(apps.expiryWarnedAt),
          lte(apps.expiresAt, horizon),
          sql`${apps.expiresAt} > ${now.toISOString()}::timestamptz`,
        ),
      );

    const warned: string[] = [];
    for (const app of due) {
      if (!app.expiresAt) continue;
      const url = formatAppUrl({ slug: app.slug, ownerHandle: app.handle, baseDomain: this.#baseDomain });
      const when = utcDay(app.expiresAt);
      await this.#mailer.send({
        to: app.email,
        subject: `SCAD: ${app.slug} expires on ${when}`,
        text: [
          `Nobody has opened ${app.slug} recently, so it will stop on ${when} (UTC).`,
          "",
          `Open it to keep it for another 30 days: ${url}`,
          "",
          "If it stays expired for 14 days, SCAD deletes it and its /data. Republishing brings back the code, not the data.",
        ].join("\n"),
      });
      // Mark after sending: a failed send is retried on the next run.
      await this.#db.update(apps).set({ expiryWarnedAt: now }).where(eq(apps.id, app.id));
      await this.#audit(app.id, "app.expiry_warning", { expires_at: app.expiresAt.toISOString() });
      warned.push(app.id);
    }
    return warned;
  }

  /** Stop apps whose `expires_at` has passed and mark them expired. Returns expired app ids. */
  async expire(): Promise<string[]> {
    const now = this.#now();
    const due = await this.#db
      .select({ id: apps.id })
      .from(apps)
      .where(and(inArray(apps.status, [...EXPIRABLE]), eq(apps.pinned, false), lte(apps.expiresAt, now)));
    const expired: string[] = [];
    for (const app of due) {
      await this.#machines.stop(app.id);
      const [row] = await this.#db
        .update(apps)
        .set({ status: "expired" })
        .where(and(eq(apps.id, app.id), inArray(apps.status, [...EXPIRABLE])))
        .returning({ id: apps.id });
      if (!row) continue; // republished or changed meanwhile
      await this.#audit(app.id, "app.expire", {});
      expired.push(app.id);
    }
    return expired;
  }

  /** Delete apps that stayed expired through the 14-day grace period. Returns deleted app ids. */
  async deleteExpired(): Promise<string[]> {
    const cutoff = new Date(this.#now().getTime() - EXPIRY_GRACE_MS);
    const due = await this.#db
      .select({ id: apps.id, slug: apps.slug })
      .from(apps)
      .where(and(eq(apps.status, "expired"), eq(apps.pinned, false), lte(apps.expiresAt, cutoff)));
    const deleted: string[] = [];
    for (const app of due) {
      // Re-checked under the app's lock: an owner may have republished it
      // since the query above, and a revived app must keep its data.
      const done = await deleteApp(
        this.#db,
        this.#machines,
        app.id,
        { actorId: null, reason: "expired" },
        (row) => row.status === "expired" && !row.pinned && row.expiresAt !== null && row.expiresAt <= cutoff,
      );
      if (done) deleted.push(app.id);
    }
    return deleted;
  }

  /**
   * Reconcile runtime state with the DB. Runtime resources with no live app
   * row are flagged (audited, never removed automatically: the daemon may be
   * shared). DB machines with nothing in the runtime are marked `missing`.
   */
  async reapOrphans(): Promise<ReapReport> {
    if (!this.#inventory) return { orphans: [], missing: [] };
    const runtimeApps = (await this.#inventory.listApps()).filter((a) => isUuid(a.appId));
    const runtimeIds = new Set(runtimeApps.map((a) => a.appId));

    const rows = await this.#db.select({ id: apps.id, status: apps.status }).from(apps);
    const live = new Set(rows.filter((r) => r.status !== "deleted").map((r) => r.id));
    const orphans = runtimeApps
      .filter((a) => !live.has(a.appId))
      .map((a) => ({ appId: a.appId, resources: [...a.resources].sort() }))
      .sort((a, b) => a.appId.localeCompare(b.appId));
    for (const orphan of orphans) {
      // Not a FK: the app row may not exist at all.
      await this.#db.insert(auditEvents).values({
        action: "runtime.orphan",
        metadata: { app_id: orphan.appId, resources: orphan.resources },
      });
    }

    const tracked = await this.#db
      .select({ appId: machines.appId })
      .from(machines)
      .innerJoin(apps, eq(apps.id, machines.appId))
      .where(and(inArray(machines.state, ["running", "stopped"]), inArray(apps.status, ["running", "stopped"])));
    const missing = tracked.map((m) => m.appId).filter((id) => !runtimeIds.has(id)).sort();
    if (missing.length > 0) {
      await this.#db.update(machines).set({ state: "missing" }).where(inArray(machines.appId, missing));
    }
    return { orphans, missing };
  }

  /**
   * Fold raw per-viewer counters into usage_daily (requests, unique viewers)
   * for today and yesterday (UTC), then drop raw rows past retention.
   * Recomputes from the raw rows, so re-running never double counts.
   */
  async rollupUsage(): Promise<number> {
    const now = this.#now();
    const since = utcDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const totals = await this.#db
      .select({
        appId: usageViewers.appId,
        day: usageViewers.day,
        requests: sql<number>`sum(${usageViewers.requests})::int`,
        uniqueViewers: sql<number>`count(*)::int`,
      })
      .from(usageViewers)
      .where(gte(usageViewers.day, since))
      .groupBy(usageViewers.appId, usageViewers.day);
    for (const t of totals) {
      await this.#db
        .insert(usageDaily)
        .values(t)
        .onConflictDoUpdate({
          target: [usageDaily.appId, usageDaily.day],
          set: { requests: t.requests, uniqueViewers: t.uniqueViewers },
        });
    }
    const oldest = utcDay(new Date(now.getTime() - USAGE_VIEWERS_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    await this.#db.delete(usageViewers).where(sql`${usageViewers.day} < ${oldest}::date`);
    return totals.length;
  }

  async #audit(appId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
    await this.#db.insert(auditEvents).values({ actorId: null, appId, action, metadata });
  }
}

type Job = { name: string; everyMs: number; run: () => Promise<unknown> };

/**
 * Run the lifecycle jobs on their cadence (T2.5): expiry notifier daily,
 * expirer and grace-period deleter every 10 minutes, orphan reaper and usage
 * roll-up hourly. Each job runs once at start, never overlaps itself, and
 * reports failures through `onError`. Returns a stop function.
 */
export function startLifecycleJobs(
  jobs: LifecycleJobs,
  opts: { onError?: (job: string, err: unknown) => void; onReap?: (report: ReapReport) => void } = {},
): () => void {
  const schedule: Job[] = [
    { name: "expiry notifier", everyMs: 24 * 60 * 60 * 1000, run: () => jobs.notifyExpiring() },
    { name: "expirer", everyMs: 10 * 60 * 1000, run: () => jobs.expire() },
    { name: "expired-app deleter", everyMs: 10 * 60 * 1000, run: () => jobs.deleteExpired() },
    {
      name: "orphan reaper",
      everyMs: 60 * 60 * 1000,
      run: async () => {
        const report = await jobs.reapOrphans();
        if (report.orphans.length > 0 || report.missing.length > 0) opts.onReap?.(report);
      },
    },
    { name: "usage roll-up", everyMs: 60 * 60 * 1000, run: () => jobs.rollupUsage() },
  ];
  const timers = schedule.map((job) => {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      job
        .run()
        .catch((err: unknown) => opts.onError?.(job.name, err))
        .finally(() => {
          running = false;
        });
    };
    tick();
    const timer = setInterval(tick, job.everyMs);
    timer.unref();
    return timer;
  });
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
