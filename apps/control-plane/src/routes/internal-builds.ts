import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { errorEnvelopeSchema } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, machines, releases } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";
import { lockApp, type Tx } from "../lifecycle/app-lock.js";
import { CANCELLED_BY_DELETE, CANCELLED_BY_SUSPEND } from "../lifecycle/delete.js";
import type { MachineController } from "../machines/controller.js";
import { accruedRunningSeconds } from "../machines/running-time.js";
import {
  appendBuildLog,
  readBuildLogTail,
  type DataPaths,
} from "../storage.js";

export type InternalBuildsOpts = {
  db: Db["db"];
  paths: DataPaths;
  internalToken: string;
  /** Tears down a deploy that finished after its app was deleted. */
  machines?: MachineController;
};

export function assertInternal(request: { headers: Record<string, unknown> }, token: string): void {
  const header = request.headers["x-scad-internal-token"];
  if (typeof header !== "string" || header !== token) {
    throw new ApiError(401, "UNAUTHENTICATED", "Invalid internal token", "Use the builder secret.");
  }
}

export const internalBuildsRoutes: FastifyPluginAsync<InternalBuildsOpts> = async (app, opts) => {
  /** In-process claim lock so multiple builders cannot process the same release. */
  const claimedReleaseIds = new Set<string>();

  app.post(
    "/internal/builds/claim",
    { config: { public: true } },
    async (request) => {
      assertInternal(request, opts.internalToken);

      const candidates = await opts.db
        .select()
        .from(releases)
        .where(eq(releases.status, "building"))
        .orderBy(asc(releases.createdAt))
        .limit(20);

      for (const release of candidates) {
        if (claimedReleaseIds.has(release.id)) continue;

        const [appRow] = await opts.db.select().from(apps).where(eq(apps.id, release.appId)).limit(1);
        if (!appRow) continue;
        if (appRow.status === "deleted" || appRow.status === "suspended") {
          // Never build for a deleted or suspended app (a delete normally cancels these already).
          await opts.db
            .update(releases)
            .set({ status: "failed", error: appRow.status === "deleted" ? CANCELLED_BY_DELETE : CANCELLED_BY_SUSPEND })
            .where(and(eq(releases.id, release.id), eq(releases.status, "building")));
          continue;
        }

        claimedReleaseIds.add(release.id);
        return {
          job: {
            releaseId: release.id,
            appId: appRow.id,
            version: release.version,
            manifest: release.manifest,
            tarballPath: opts.paths.tarballPath(release.id),
          },
        };
      }

      return { job: null };
    },
  );

  app.post(
    "/internal/builds/:id/log",
    { config: { public: true } },
    async (request) => {
      assertInternal(request, opts.internalToken);
      const { id } = request.params as { id: string };
      const body = z.object({ chunk: z.string() }).safeParse(request.body);
      if (!body.success) throw validationFailed("chunk is required");
      await appendBuildLog(opts.paths, id, body.data.chunk);
      return { ok: true };
    },
  );

  app.post(
    "/internal/builds/:id/complete",
    { config: { public: true } },
    async (request) => {
      assertInternal(request, opts.internalToken);
      const { id } = request.params as { id: string };
      const body = completionBody.safeParse(request.body);
      if (!body.success) {
        throw validationFailed("Invalid completion payload", {
          issues: body.error.issues,
        });
      }

      const [found] = await opts.db.select().from(releases).where(eq(releases.id, id)).limit(1);
      if (!found) {
        throw new ApiError(404, "NOT_FOUND", "Release not found", "Unknown release id.");
      }

      claimedReleaseIds.delete(id);

      // Under the app's lock so a delete can't interleave; re-read both rows.
      const outcome = await opts.db.transaction(async (tx) => {
        await lockApp(tx, found.appId);
        const [release] = await tx.select().from(releases).where(eq(releases.id, id)).limit(1);
        const [appRow] = await tx.select({ status: apps.status }).from(apps).where(eq(apps.id, found.appId)).limit(1);
        if (!release || release.status !== "building" || !appRow || appRow.status === "deleted") {
          // Cancelled (the app was deleted mid-build): discard the result, and
          // if the builder already deployed, remove what it created.
          return { discarded: true, teardown: body.data.ok && appRow?.status === "deleted" };
        }
        await applyCompletion(tx, opts.paths, release, body.data);
        // Suspended mid-build: keep the release, but the app must not run (T2.6).
        return { discarded: false, teardown: false, stop: body.data.ok && appRow.status === "suspended" };
      });
      if (outcome.teardown && opts.machines) {
        await opts.machines.removeApp(found.appId);
      }
      if ("stop" in outcome && outcome.stop && opts.machines) {
        await opts.machines.stop(found.appId);
      }
      return outcome.discarded ? { ok: true, discarded: true } : { ok: true };
    },
  );
};

/** Builder → control plane: how a claimed release ended. */
const completionBody = z
  .discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      imageRef: z.string().min(1),
      providerId: z.string().min(1),
    }),
    z.object({
      ok: z.literal(false),
      error: errorEnvelopeSchema,
    }),
  ]);
type Completion = z.infer<typeof completionBody>;

/** Record a finished build that is still wanted (its app exists, its release is building). */
async function applyCompletion(
  tx: Tx,
  paths: DataPaths,
  release: typeof releases.$inferSelect,
  data: Completion,
): Promise<void> {
  if (data.ok) {
    await tx
      .update(releases)
      .set({
        status: "ready",
        imageRef: data.imageRef,
        error: null,
      })
      .where(eq(releases.id, release.id));

    // The new release is what the app serves now (T3.6), suspended or not.
    await tx.update(apps).set({ currentReleaseId: release.id }).where(eq(apps.id, release.appId));
    await tx
      .update(apps)
      .set({ status: "running" })
      .where(and(eq(apps.id, release.appId), ne(apps.status, "suspended")));

    await tx
      .insert(machines)
      .values({
        appId: release.appId,
        providerId: data.providerId,
        volumeRef: `scad-data-${release.appId}`,
        state: "running",
        lastStartedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: machines.appId,
        set: {
          providerId: data.providerId,
          runningSeconds: accruedRunningSeconds(new Date()),
          state: "running",
          lastStartedAt: new Date(),
        },
      });
  } else {
    const logTail = await readBuildLogTail(paths, release.id, 50);
    const error = {
      ...data.error,
      details: {
        ...data.error.details,
        log_tail: logTail,
      },
    };
    await tx
      .update(releases)
      .set({
        status: "failed",
        error,
      })
      .where(eq(releases.id, release.id));

    // Leave previous ready release serving: if any ready release exists, app stays running.
    const ready = await tx
      .select()
      .from(releases)
      .where(and(eq(releases.appId, release.appId), eq(releases.status, "ready")))
      .limit(1);
    await tx
      .update(apps)
      .set({ status: ready[0] ? "running" : "stopped" })
      .where(and(eq(apps.id, release.appId), ne(apps.status, "suspended")));
  }
}
