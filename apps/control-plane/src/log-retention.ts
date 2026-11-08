import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db/client.js";
import { pruneRuntimeLogs } from "./logs/runtime-log-store.js";
import type { DataPaths } from "./storage.js";

/** AGENTS §14: keep logs 7 days. */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete build logs last written more than `maxAgeMs` ago. Runtime logs live
 * in the `runtime_logs` table and are deleted by `pruneRuntimeLogs`.
 */
export async function pruneBuildLogs(
  paths: DataPaths,
  now = new Date(),
  maxAgeMs = LOG_RETENTION_MS,
): Promise<{ deleted: number }> {
  const dir = join(paths.root, "logs");
  const cutoff = now.getTime() - maxAgeMs;
  let deleted = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { deleted };
  }
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await unlink(file);
        deleted += 1;
      }
    } catch {
      // Vanished or unreadable: the next run retries.
    }
  }
  return { deleted };
}

/**
 * Run the 7-day retention now and then daily: deletes old build log files
 * and, when `db` is given, old rows in `runtime_logs`. Returns a stop function.
 */
export function startLogRetention(
  paths: DataPaths,
  opts: { db?: Db["db"]; intervalMs?: number; onError?: (err: unknown) => void } = {},
): () => void {
  const run = () => {
    pruneBuildLogs(paths).catch((err: unknown) => opts.onError?.(err));
    if (opts.db) pruneRuntimeLogs(opts.db).catch((err: unknown) => opts.onError?.(err));
  };
  run();
  const timer = setInterval(run, opts.intervalMs ?? 24 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
