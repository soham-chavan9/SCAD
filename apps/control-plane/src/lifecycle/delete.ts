import { and, eq } from "drizzle-orm";
import type { ErrorEnvelope } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, releases } from "../db/schema.js";
import type { MachineController } from "../machines/controller.js";
import { lockApp } from "./app-lock.js";
import { purgeAppData } from "./purge.js";

type AppRow = typeof apps.$inferSelect;

/** Stored on releases that were still building when their app was deleted. */
export const CANCELLED_BY_DELETE: ErrorEnvelope = {
  code: "NOT_FOUND",
  message: "The app was deleted while this release was building",
  hint: "Publish the app again to start fresh.",
  details: {},
};

/**
 * Delete an app: cancel its outstanding builds, remove its container, network,
 * and /data volume, and purge its data (shares, env, logs). Runs under the
 * per-app lock, re-reading the app first, so a republish or a finishing build
 * can't interleave. `stillEligible` decides on the fresh row (the expiry
 * deleter uses it so a just-revived app is left alone). Returns false when the
 * app was not deleted (already gone, or no longer eligible).
 */
export async function deleteApp(
  db: Db["db"],
  machines: MachineController,
  appId: string,
  audit: { actorId: string | null; reason: "owner" | "expired" },
  stillEligible: (row: AppRow) => boolean = () => true,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockApp(tx, appId);
    const [row] = await tx.select().from(apps).where(eq(apps.id, appId)).limit(1);
    if (!row || row.status === "deleted" || !stillEligible(row)) return false;

    // A builder holding one of these can no longer fetch env or complete it.
    await tx
      .update(releases)
      .set({ status: "failed", error: CANCELLED_BY_DELETE })
      .where(and(eq(releases.appId, appId), eq(releases.status, "building")));
    await machines.removeApp(appId);
    await purgeAppData(tx, row, audit);
    return true;
  });
}
