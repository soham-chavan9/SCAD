import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, lt } from "drizzle-orm";
import { formatAppUrl } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, auditEvents, releases, users } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { MachineController } from "../machines/controller.js";
import { currentRelease } from "../releases/current.js";
import type { MasterKeyRing } from "../secrets/crypto.js";
import { loadRuntimeEnv } from "../secrets/env-store.js";
import { findOwnedApp } from "./share.js";

export type RollbackRoutesOpts = {
  db: Db["db"];
  baseDomain: string;
  machines?: MachineController;
  masterKeys?: MasterKeyRing;
};

/**
 * POST /v1/apps/:id/rollback (T3.6): serve the release before the current
 * one again, in one step ("that update broke it, go back"). The earlier image
 * is redeployed with the app's current env vars; its /data volume is not
 * touched. Rolling back again goes one more step back; the next publish
 * becomes current. Owner only (INV10: anyone else gets 404).
 */
export const rollbackRoutes: FastifyPluginAsync<RollbackRoutesOpts> = async (app, opts) => {
  app.post<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug/rollback", async (request) => {
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    if (!opts.machines) {
      throw new ApiError(
        503,
        "INTERNAL",
        "Going back to an earlier version is not available on this SCAD instance",
        "Ask the SCAD operator to start the control plane with a runtime.",
      );
    }
    const [row] = await opts.db
      .select({ status: apps.status, ownerHandle: users.handle })
      .from(apps)
      .innerJoin(users, eq(users.id, apps.ownerId))
      .where(eq(apps.id, owned.id))
      .limit(1);
    if (row?.status === "suspended") {
      throw new ApiError(
        403,
        "APP_SUSPENDED",
        "This site is suspended by the SCAD operator",
        "Ask the operator to lift the suspension; nothing can be changed until then.",
      );
    }

    const current = await currentRelease(opts.db, owned.id);
    if (!current) {
      throw new ApiError(
        409,
        "VALIDATION_FAILED",
        "This site has no working version yet, so there is nothing to go back to",
        "Fix the build error and publish again.",
      );
    }
    const [target] = await opts.db
      .select()
      .from(releases)
      .where(and(eq(releases.appId, owned.id), eq(releases.status, "ready"), lt(releases.version, current.version)))
      .orderBy(desc(releases.version))
      .limit(1);
    if (!target) {
      throw new ApiError(
        409,
        "VALIDATION_FAILED",
        `Version ${current.version} is the oldest working version of this site; there is nothing earlier to go back to`,
        "Fix the problem in the files and publish again instead.",
        { current_version: current.version },
      );
    }

    const env = opts.masterKeys ? await loadRuntimeEnv(opts.db, opts.masterKeys, owned.id) : {};
    const deployed = await opts.machines.deployRelease(owned.id, target.id, env);
    if (!deployed) {
      throw new ApiError(
        409,
        "VALIDATION_FAILED",
        "This site cannot be switched right now",
        "Check the site with get_app, then try again.",
      );
    }

    await opts.db.insert(auditEvents).values({
      actorId: request.user.id,
      appId: owned.id,
      action: "app.rollback",
      metadata: {
        from_release_id: current.id,
        from_version: current.version,
        to_release_id: target.id,
        to_version: target.version,
      },
    });

    return {
      app_id: owned.id,
      slug: owned.slug,
      url: row ? formatAppUrl({ slug: owned.slug, ownerHandle: row.ownerHandle, baseDomain: opts.baseDomain }) : null,
      release: { id: target.id, version: target.version },
      previous: { id: current.id, version: current.version },
      message: `Went back from version ${current.version} to version ${target.version}. Saved data was not changed.`,
    };
  });
};
