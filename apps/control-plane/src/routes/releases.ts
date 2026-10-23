import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../db/client.js";
import { apps, releases } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { readBuildLogTail, type DataPaths } from "../storage.js";

export type ReleasesRoutesOpts = {
  db: Db["db"];
  paths: DataPaths;
};

export const releasesRoutes: FastifyPluginAsync<ReleasesRoutesOpts> = async (app, opts) => {
  app.get("/v1/releases/:id", async (request) => {
    const { id } = request.params as { id: string };
    const rows = await opts.db
      .select({
        release: releases,
        ownerId: apps.ownerId,
      })
      .from(releases)
      .innerJoin(apps, eq(releases.appId, apps.id))
      .where(eq(releases.id, id))
      .limit(1);

    const row = rows[0];
    if (!row || row.ownerId !== request.user.id) {
      throw new ApiError(404, "NOT_FOUND", "Release not found", "Check the release id and retry.");
    }

    const logTail = await readBuildLogTail(opts.paths, row.release.id, 50);
    return {
      id: row.release.id,
      appId: row.release.appId,
      version: row.release.version,
      status: row.release.status,
      imageRef: row.release.imageRef,
      error: row.release.error,
      log_tail: logTail,
    };
  });
};
