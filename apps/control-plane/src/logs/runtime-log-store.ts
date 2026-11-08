import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runtimeLogs } from "../db/schema.js";

/** AGENTS §14: keep runtime logs 7 days. */
export const RUNTIME_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RuntimeLogInsert = { appId: string; providerId: string; line: string; at?: Date };
export type RuntimeLogRow = { id: number; line: string };

export async function appendRuntimeLogs(db: Db["db"], rows: RuntimeLogInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(runtimeLogs).values(
    rows.map((r) => ({ appId: r.appId, providerId: r.providerId, line: r.line, ...(r.at ? { at: r.at } : {}) })),
  );
}

/** The last `tail` lines of an app, oldest first. */
export async function recentRuntimeLogs(db: Db["db"], appId: string, tail: number): Promise<RuntimeLogRow[]> {
  if (tail <= 0) return [];
  const rows = await db
    .select({ id: runtimeLogs.id, line: runtimeLogs.line })
    .from(runtimeLogs)
    .where(eq(runtimeLogs.appId, appId))
    .orderBy(desc(runtimeLogs.id))
    .limit(tail);
  return rows.reverse();
}

/** Lines stored after `afterId`, oldest first (used by `-f`). */
export async function runtimeLogsAfter(
  db: Db["db"],
  appId: string,
  afterId: number,
  limit = 1000,
): Promise<RuntimeLogRow[]> {
  return db
    .select({ id: runtimeLogs.id, line: runtimeLogs.line })
    .from(runtimeLogs)
    .where(and(eq(runtimeLogs.appId, appId), gt(runtimeLogs.id, afterId)))
    .orderBy(asc(runtimeLogs.id))
    .limit(limit);
}

/** Highest stored id for the app (0 when none). */
export async function lastRuntimeLogId(db: Db["db"], appId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${runtimeLogs.id})` })
    .from(runtimeLogs)
    .where(eq(runtimeLogs.appId, appId));
  return Number(row?.max ?? 0);
}

/** Whether any line of this container is already stored. */
export async function hasContainerLogs(db: Db["db"], appId: string, providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runtimeLogs.id })
    .from(runtimeLogs)
    .where(and(eq(runtimeLogs.appId, appId), eq(runtimeLogs.providerId, providerId)))
    .limit(1);
  return Boolean(row);
}

/** Delete (not hide) every runtime log row older than `maxAgeMs`. */
export async function pruneRuntimeLogs(
  db: Db["db"],
  now = new Date(),
  maxAgeMs = RUNTIME_LOG_RETENTION_MS,
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - maxAgeMs);
  // Count in SQL so a large purge doesn't ship every deleted id back.
  const [row] = await db.execute<{ n: number }>(sql`
    WITH d AS (DELETE FROM ${runtimeLogs} WHERE ${runtimeLogs.at} < ${cutoff.toISOString()}::timestamptz RETURNING 1)
    SELECT count(*)::int AS n FROM d
  `);
  return { deleted: row?.n ?? 0 };
}
