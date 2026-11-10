import { sql, type SQL } from "drizzle-orm";
import { machines } from "../db/schema.js";

/**
 * Running time (T2.7). `running_seconds` holds the time of finished runs; the
 * current run is `now - last_started_at` while `state = 'running'`. Every
 * write that ends a run or restarts the clock (stop, wake, deploy) first folds
 * the current run in with this expression, so nothing is counted twice.
 */
export function accruedRunningSeconds(now: Date): SQL<number> {
  return sql<number>`${machines.runningSeconds} + ${currentRunSeconds(now)}`;
}

/** Seconds of the current run (0 when not running). */
export function currentRunSeconds(now: Date): SQL<number> {
  return sql<number>`(CASE WHEN ${machines.state} = 'running' AND ${machines.lastStartedAt} IS NOT NULL
    THEN greatest(0, floor(extract(epoch from (${now.toISOString()}::timestamptz - ${machines.lastStartedAt}))))::bigint
    ELSE 0 END)`;
}
