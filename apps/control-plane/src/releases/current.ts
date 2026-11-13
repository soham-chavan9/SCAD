import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apps, releases } from "../db/schema.js";

export type ReleaseRow = typeof releases.$inferSelect;
type Query = Pick<Db["db"], "select">;

/**
 * The release an app serves (T3.6): `apps.current_release_id` when it points
 * at a ready release (set by a successful build and by rollback), else the
 * latest ready release (rows from before T3.6). Null when nothing is ready.
 */
export async function currentRelease(db: Query, appId: string): Promise<ReleaseRow | null> {
  const [pinned] = await db
    .select({ release: releases })
    .from(apps)
    .innerJoin(releases, eq(releases.id, apps.currentReleaseId))
    .where(and(eq(apps.id, appId), eq(releases.status, "ready")))
    .limit(1);
  if (pinned) return pinned.release;
  const [latest] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.appId, appId), eq(releases.status, "ready")))
    .orderBy(desc(releases.version))
    .limit(1);
  return latest ?? null;
}
