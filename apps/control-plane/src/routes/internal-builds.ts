import { and, asc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { errorEnvelopeSchema } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, machines, releases } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";
import {
  appendBuildLog,
  readBuildLogTail,
  type DataPaths,
} from "../storage.js";

export type InternalBuildsOpts = {
  db: Db["db"];
  paths: DataPaths;
  internalToken: string;
};

function assertInternal(request: { headers: Record<string, unknown> }, token: string): void {
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
      const body = z
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
        ])
        .safeParse(request.body);
      if (!body.success) {
        throw validationFailed("Invalid completion payload", {
          issues: body.error.issues,
        });
      }

      const [release] = await opts.db.select().from(releases).where(eq(releases.id, id)).limit(1);
      if (!release) {
        throw new ApiError(404, "NOT_FOUND", "Release not found", "Unknown release id.");
      }

      claimedReleaseIds.delete(id);

      if (body.data.ok) {
        await opts.db
          .update(releases)
          .set({
            status: "ready",
            imageRef: body.data.imageRef,
            error: null,
          })
          .where(eq(releases.id, id));

        await opts.db.update(apps).set({ status: "running" }).where(eq(apps.id, release.appId));

        await opts.db
          .insert(machines)
          .values({
            appId: release.appId,
            providerId: body.data.providerId,
            volumeRef: `scad-data-${release.appId}`,
            state: "running",
            lastStartedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: machines.appId,
            set: {
              providerId: body.data.providerId,
              state: "running",
              lastStartedAt: new Date(),
            },
          });
      } else {
        const logTail = await readBuildLogTail(opts.paths, id, 50);
        const error = {
          ...body.data.error,
          details: {
            ...body.data.error.details,
            log_tail: logTail,
          },
        };
        await opts.db
          .update(releases)
          .set({
            status: "failed",
            error,
          })
          .where(eq(releases.id, id));

        // Leave previous ready release serving: if any ready release exists, app stays running.
        const ready = await opts.db
          .select()
          .from(releases)
          .where(and(eq(releases.appId, release.appId), eq(releases.status, "ready")))
          .limit(1);
        await opts.db
          .update(apps)
          .set({ status: ready[0] ? "running" : "stopped" })
          .where(eq(apps.id, release.appId));
      }

      return { ok: true };
    },
  );
};
