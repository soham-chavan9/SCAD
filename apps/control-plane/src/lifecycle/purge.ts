import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Tx } from "./app-lock.js";
import { appAccess, apps, auditEvents, envVars, runtimeLogs } from "../db/schema.js";

/**
 * Forget an app's data after its runtime resources are gone: shares, env vars
 * (incl. secrets), and runtime logs. The row stays as `deleted` for audit, so
 * publishing the same name later starts fresh. `actorId` null = the platform.
 */
export async function purgeAppData(
  db: Db["db"] | Tx,
  app: { id: string; slug: string },
  audit: { actorId: string | null; reason: "owner" | "expired" },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(appAccess).where(eq(appAccess.appId, app.id));
    await tx.delete(envVars).where(eq(envVars.appId, app.id));
    await tx.delete(runtimeLogs).where(eq(runtimeLogs.appId, app.id));
    await tx.update(apps).set({ status: "deleted", pinned: false }).where(eq(apps.id, app.id));
    await tx.insert(auditEvents).values({
      actorId: audit.actorId,
      appId: app.id,
      action: "app.delete",
      metadata: { slug: app.slug, reason: audit.reason },
    });
  });
}
