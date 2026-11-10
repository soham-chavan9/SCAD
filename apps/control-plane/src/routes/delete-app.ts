import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../db/client.js";
import { ApiError } from "../errors.js";
import { deleteApp } from "../lifecycle/delete.js";
import type { MachineController } from "../machines/controller.js";
import { findOwnedApp } from "./share.js";

export type DeleteAppRoutesOpts = {
  db: Db["db"];
  machines?: MachineController;
};

export const deleteAppRoutes: FastifyPluginAsync<DeleteAppRoutesOpts> = async (app, opts) => {
  /**
   * §8 DELETE /v1/apps/:id. Owner only (INV10; others get 404). Removes the
   * container, network, and /data volume, then clears shares, env vars, and
   * runtime logs. The app row stays as `deleted` (for audit), and publishing
   * the same name later starts fresh. Builds still in flight are cancelled,
   * and a build that finishes afterwards is discarded (internal-builds.ts).
   */
  app.delete<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug", async (request) => {
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    if (!opts.machines) {
      throw new ApiError(503, "INTERNAL", "Deleting apps is not available on this instance", "Start the control plane with a runtime.");
    }
    await deleteApp(opts.db, opts.machines, owned.id, { actorId: request.user.id, reason: "owner" });
    return { app_id: owned.id, slug: owned.slug, status: "deleted" as const };
  });
};
