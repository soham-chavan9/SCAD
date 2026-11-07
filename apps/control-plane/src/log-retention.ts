import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DataPaths } from "./storage.js";

/** AGENTS §14: keep logs 7 days. */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete build logs last written more than `maxAgeMs` ago. Runtime logs live
 * in Docker (rotated by size; the driver serves only the last 7 days).
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

/** Run `pruneBuildLogs` now and then daily. Returns a stop function. */
export function startLogRetention(
  paths: DataPaths,
  opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): () => void {
  const run = () => {
    pruneBuildLogs(paths).catch((err: unknown) => opts.onError?.(err));
  };
  run();
  const timer = setInterval(run, opts.intervalMs ?? 24 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
