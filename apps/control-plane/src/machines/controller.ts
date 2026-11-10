import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { deploySpecFromManifest } from "@scad/shared";
import type { ManagedRuntime } from "@scad/runtime-conformance";
import type { Db } from "../db/client.js";
import { apps, auditEvents, machines, releases, usageViewers } from "../db/schema.js";
import { renewedExpiry, utcDay } from "../lifecycle/policy.js";
import { accruedRunningSeconds } from "./running-time.js";
import { ApiError } from "../errors.js";

/** AGENTS §14 default: stop an app after 10 minutes without traffic. */
export const IDLE_STOP_MS = 10 * 60_000;
/** How often running apps' /data volumes are measured against their limit (T1.3). */
export const VOLUME_QUOTA_SWEEP_MS = 5 * 60_000;

export type MachineControllerOpts = {
  db: Db["db"];
  runtime: ManagedRuntime;
  now?: () => Date;
  idleMs?: number;
  /** Told when a machine is (re)started so its output is collected at once (T1.7b). */
  onMachineRunning?: (appId: string, providerId: string) => void;
};

type Op = { kind: "wake" | "stop" | "deploy"; done: Promise<unknown> };

/**
 * Starts and stops app machines. One operation per app at a time, and
 * concurrent wakes share one in-flight start (T1.4 single-flight).
 */
export class MachineController {
  readonly #db: Db["db"];
  readonly #runtime: ManagedRuntime;
  readonly #now: () => Date;
  readonly #idleMs: number;
  readonly #ops = new Map<string, Op>();
  readonly #onMachineRunning: (appId: string, providerId: string) => void;

  constructor(opts: MachineControllerOpts) {
    this.#db = opts.db;
    this.#runtime = opts.runtime;
    this.#now = opts.now ?? (() => new Date());
    this.#idleMs = opts.idleMs ?? IDLE_STOP_MS;
    this.#onMachineRunning = opts.onMachineRunning ?? (() => undefined);
  }

  /** Start the app's machine if it is stopped. Resolves once the runtime reports it started. */
  async wake(appId: string): Promise<{ state: "running" }> {
    const current = this.#ops.get(appId);
    if (current?.kind === "wake") {
      await current.done;
      return { state: "running" };
    }
    if (current?.kind === "stop") {
      await current.done.catch(() => undefined);
      return this.wake(appId);
    }
    const done = this.#doWake(appId);
    this.#track(appId, { kind: "wake", done });
    await done;
    return { state: "running" };
  }

  /**
   * Re-deploy the latest ready release with `runtimeEnv` (env changes, T1.6).
   * Returns false when there is no ready release to deploy yet.
   */
  async redeploy(appId: string, runtimeEnv: Record<string, string>): Promise<boolean> {
    const current = this.#ops.get(appId);
    if (current) await current.done.catch(() => undefined);
    const done = this.#doRedeploy(appId, runtimeEnv);
    this.#track(appId, { kind: "deploy", done });
    return done;
  }

  async #doRedeploy(appId: string, runtimeEnv: Record<string, string>): Promise<boolean> {
    const [app] = await this.#db.select({ status: apps.status }).from(apps).where(eq(apps.id, appId)).limit(1);
    // A suspended app stays stopped; the new env applies once it is lifted (T2.6).
    if (!app || app.status === "suspended" || app.status === "deleted") return false;
    const [release] = await this.#db
      .select({ imageRef: releases.imageRef, manifest: releases.manifest })
      .from(releases)
      .where(and(eq(releases.appId, appId), eq(releases.status, "ready")))
      .orderBy(desc(releases.version))
      .limit(1);
    if (!release?.imageRef) return false;

    const spec = deploySpecFromManifest({
      appId,
      imageRef: release.imageRef,
      manifest: release.manifest,
      runtimeEnv,
    });
    await this.#runtime.ensureApp(appId, spec.limits.diskGb);
    const machine = await this.#runtime.deploy(spec);
    const now = this.#now();
    await this.#db
      .insert(machines)
      .values({
        appId,
        providerId: machine.providerId,
        volumeRef: `scad-data-${appId}`,
        state: "running",
        lastStartedAt: now,
      })
      .onConflictDoUpdate({
        target: machines.appId,
        set: {
          providerId: machine.providerId,
          runningSeconds: accruedRunningSeconds(now),
          state: "running",
          lastStartedAt: now,
        },
      });
    await this.#db
      .update(apps)
      .set({ status: "running" })
      .where(and(eq(apps.id, appId), eq(apps.status, "stopped")));
    this.#onMachineRunning(appId, machine.providerId);
    return true;
  }

  /** Remove the app's container, network, and /data volume, and forget its machine. */
  async removeApp(appId: string): Promise<void> {
    const current = this.#ops.get(appId);
    if (current) await current.done.catch(() => undefined);
    const done = (async () => {
      await this.#runtime.remove(appId, { deleteVolume: true });
      await this.#db.delete(machines).where(eq(machines.appId, appId));
    })();
    this.#track(appId, { kind: "stop", done });
    await done;
  }

  /**
   * Record traffic (gateway touch, debounced): keeps the app awake, marks it
   * viewed, renews its 30-day expiry (D8), and counts the viewer for usage.
   * Apps that already expired, were suspended, or deleted are not renewed.
   */
  async touch(appId: string, userId?: string, requests = 1): Promise<void> {
    const now = this.#now();
    await this.#db.update(machines).set({ lastRequestAt: now }).where(eq(machines.appId, appId));
    await this.#db
      .update(apps)
      .set({ lastViewedAt: now, ...renewedExpiry(now) })
      .where(and(eq(apps.id, appId), inArray(apps.status, ["building", "running", "stopped"])));
    if (userId) {
      await this.#db
        .insert(usageViewers)
        .values({ appId, day: utcDay(now), userId, requests })
        .onConflictDoUpdate({
          target: [usageViewers.appId, usageViewers.day, usageViewers.userId],
          set: { requests: sql`${usageViewers.requests} + ${requests}` },
        });
    }
  }

  /** Stop the app's machine if it has one (expiry, T2.5). No-op when there is none. */
  async stop(appId: string): Promise<void> {
    const current = this.#ops.get(appId);
    if (current) await current.done.catch(() => undefined);
    const [row] = await this.#db
      .select({ providerId: machines.providerId })
      .from(machines)
      .where(eq(machines.appId, appId))
      .limit(1);
    if (!row?.providerId) return;
    const done = this.#doStop(appId, row.providerId);
    this.#track(appId, { kind: "stop", done });
    await done;
  }

  /** Stop every running, unpinned app idle longer than the threshold. Returns stopped app ids. */
  async stopIdle(): Promise<string[]> {
    const cutoff = new Date(this.#now().getTime() - this.#idleMs);
    const candidates = await this.#db
      .select({ appId: machines.appId, providerId: machines.providerId })
      .from(machines)
      .innerJoin(apps, eq(apps.id, machines.appId))
      .where(
        and(
          eq(machines.state, "running"),
          eq(apps.pinned, false),
          eq(apps.status, "running"),
          sql`greatest(
            coalesce(${machines.lastRequestAt}, 'epoch'::timestamptz),
            coalesce(${machines.lastStartedAt}, 'epoch'::timestamptz)
          ) < ${cutoff.toISOString()}::timestamptz`,
        ),
      );

    const stopped: string[] = [];
    for (const row of candidates) {
      if (this.#ops.has(row.appId) || !row.providerId) continue;
      const done = this.#doStop(row.appId, row.providerId);
      this.#track(row.appId, { kind: "stop", done });
      try {
        await done;
        stopped.push(row.appId);
      } catch {
        // Leave state as-is; the next sweep retries.
      }
    }
    return stopped;
  }

  /**
   * Stop every running app whose `/data` volume is over its limit (the measured
   * quota, T1.3), so an app that keeps getting traffic cannot fill the disk.
   * No-op for a runtime without quota support. Returns stopped app ids.
   */
  async enforceVolumeQuotas(): Promise<string[]> {
    const runtime = this.#runtime;
    if (!runtime.enforceVolumeQuota) return [];
    const candidates = await this.#db
      .select({ appId: machines.appId, providerId: machines.providerId })
      .from(machines)
      .innerJoin(apps, eq(apps.id, machines.appId))
      .where(and(eq(machines.state, "running"), eq(apps.status, "running")));

    const stopped: string[] = [];
    for (const row of candidates) {
      if (this.#ops.has(row.appId) || !row.providerId) continue;
      const ref = { appId: row.appId, providerId: row.providerId };
      const done = (async () => {
        // Same sweep heals platform containers that were recreated (see reconnect).
        await runtime.reconnect?.(ref);
        if (runtime.volumeUsage) {
          // Record the size for the usage page (T2.7); only re-check over-limit volumes.
          const usage = await runtime.volumeUsage(row.appId);
          await this.#db
            .update(machines)
            .set({ volumeBytes: usage.usedBytes, volumeMeasuredAt: this.#now() })
            .where(eq(machines.appId, row.appId));
          if (usage.usedBytes <= usage.limitBytes) return false;
        }
        if ((await runtime.enforceVolumeQuota!(ref)) !== "stopped") return false;
        await this.#db
          .update(machines)
          .set({ runningSeconds: accruedRunningSeconds(this.#now()), state: "stopped" })
          .where(eq(machines.appId, row.appId));
        await this.#db
          .update(apps)
          .set({ status: "stopped" })
          .where(and(eq(apps.id, row.appId), eq(apps.status, "running")));
        await this.#db
          .insert(auditEvents)
          .values({ actorId: null, appId: row.appId, action: "app.quota_stop", metadata: {} });
        return true;
      })();
      this.#track(row.appId, { kind: "stop", done });
      try {
        if (await done) stopped.push(row.appId);
      } catch {
        // Measuring failed; the next sweep retries.
      }
    }
    return stopped;
  }

  #track(appId: string, op: Op): void {
    this.#ops.set(appId, op);
    void op.done
      .catch(() => undefined)
      .finally(() => {
        if (this.#ops.get(appId) === op) this.#ops.delete(appId);
      });
  }

  async #doWake(appId: string): Promise<void> {
    const [row] = await this.#db
      .select({ status: apps.status, providerId: machines.providerId })
      .from(apps)
      .leftJoin(machines, eq(machines.appId, apps.id))
      .where(eq(apps.id, appId))
      .limit(1);
    if (!row || row.status === "deleted") {
      throw new ApiError(404, "NOT_FOUND", "App not found", "Check the app id.");
    }
    if (row.status === "suspended") {
      throw new ApiError(403, "APP_SUSPENDED", "App is suspended", "Ask an operator to lift the suspension.");
    }
    if (row.status === "expired") {
      throw new ApiError(410, "APP_EXPIRED", "App has expired", "Republish the app to bring it back.");
    }
    if (!row.providerId) {
      throw new ApiError(404, "NOT_FOUND", "App has no deployed release", "Publish the app with `scad publish`.");
    }

    const ref = { appId, providerId: row.providerId };
    // The gateway only wakes an app it can't reach; a recreated gateway or
    // egress proxy is no longer on the app's network, so put it back first.
    await this.#runtime.reconnect?.(ref);
    const status = await this.#runtime.status(ref);
    if (status === "missing") {
      throw new ApiError(404, "NOT_FOUND", "App container is missing", "Republish the app with `scad publish`.");
    }
    if (status === "stopped") {
      try {
        await this.#runtime.start(ref);
      } catch (err) {
        if (err instanceof Error && err.name === "VolumeQuotaExceededError") {
          throw new ApiError(
            507,
            "LIMIT_EXCEEDED",
            "The app's /data volume is over its size limit",
            'Delete data under /data, or raise "resources.disk_gb" in scad.json (cap 5), then republish.',
          );
        }
        throw err;
      }
    }

    this.#onMachineRunning(appId, row.providerId);
    const now = this.#now();
    await this.#db
      .update(machines)
      .set({ runningSeconds: accruedRunningSeconds(now), state: "running", lastStartedAt: now, lastRequestAt: now })
      .where(eq(machines.appId, appId));
    await this.#db
      .update(apps)
      .set({ status: "running" })
      .where(and(eq(apps.id, appId), eq(apps.status, "stopped")));
  }

  async #doStop(appId: string, providerId: string): Promise<void> {
    await this.#runtime.stop({ appId, providerId });
    await this.#db
      .update(machines)
      .set({ runningSeconds: accruedRunningSeconds(this.#now()), state: "stopped" })
      .where(eq(machines.appId, appId));
    await this.#db
      .update(apps)
      .set({ status: "stopped" })
      .where(and(eq(apps.id, appId), eq(apps.status, "running")));
  }
}

/** Run `stopIdle` on an interval (default every minute). Returns a stop function. */
export function startIdleStopper(
  controller: MachineController,
  opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): () => void {
  return everyInterval(() => controller.stopIdle(), opts.intervalMs ?? 60_000, opts.onError);
}

/** Run `enforceVolumeQuotas` on an interval (default every 5 minutes). Returns a stop function. */
export function startVolumeQuotaSweep(
  controller: MachineController,
  opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): () => void {
  return everyInterval(() => controller.enforceVolumeQuotas(), opts.intervalMs ?? VOLUME_QUOTA_SWEEP_MS, opts.onError);
}

/** Run `work` every `ms`, never overlapping itself. */
function everyInterval(work: () => Promise<unknown>, ms: number, onError?: (err: unknown) => void): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    work()
      .catch((err: unknown) => onError?.(err))
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref();
  return () => clearInterval(timer);
}
