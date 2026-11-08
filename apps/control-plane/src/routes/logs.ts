import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { machines } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { lastRuntimeLogId, recentRuntimeLogs, runtimeLogsAfter } from "../logs/runtime-log-store.js";
import { findOwnedApp } from "./share.js";

export type LogsRoutesOpts = {
  db: Db["db"];
  /** How often `-f` checks the store for new lines. */
  followPollMs?: number;
};

const query = z.object({
  follow: z.enum(["1", "true", "0", "false"]).optional(),
  tail: z.coerce.number().int().min(0).max(10_000).default(100),
});

/** Keep the connection alive through proxies while a quiet app is followed. */
const HEARTBEAT_MS = 15_000;

/** One log line as one SSE event. CR is dropped so a line can't forge extra SSE fields. */
function sseData(line: string): string {
  return `data: ${line.replaceAll("\r", "")}\n\n`;
}

export const logsRoutes: FastifyPluginAsync<LogsRoutesOpts> = async (app, opts) => {
  const pollMs = opts.followPollMs ?? 300;

  /**
   * §8: SSE runtime log, read from SCAD's runtime log store (T1.7b).
   * Owner only (INV10); shared viewers get 404 like strangers.
   */
  app.get<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug/logs", async (request, reply) => {
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_FAILED", "Invalid logs query", "Use ?follow=1 and ?tail=N (0 to 10000).");
    }
    const follow = parsed.data.follow === "1" || parsed.data.follow === "true";

    const initial = await recentRuntimeLogs(opts.db, owned.id, parsed.data.tail);
    if (initial.length === 0) {
      const [machine] = await opts.db
        .select({ providerId: machines.providerId })
        .from(machines)
        .where(eq(machines.appId, owned.id))
        .limit(1);
      if (!machine?.providerId) {
        throw new ApiError(404, "NOT_FOUND", "App has no running release yet", "Publish the app with `scad publish`, then retry.");
      }
    }
    let lastId = initial.at(-1)?.id ?? (follow ? await lastRuntimeLogId(opts.db, owned.id) : 0);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let closed = false;
    raw.on("close", () => {
      closed = true;
    });
    for (const row of initial) raw.write(sseData(row.line));
    if (!follow) {
      raw.write("event: end\ndata: \n\n");
      raw.end();
      return;
    }

    const heartbeat = setInterval(() => raw.write(": keepalive\n\n"), HEARTBEAT_MS);
    try {
      while (!closed) {
        const rows = await runtimeLogsAfter(opts.db, owned.id, lastId);
        for (const row of rows) {
          if (closed) break;
          raw.write(sseData(row.line));
          lastId = row.id;
        }
        if (rows.length === 0) await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch {
      if (!closed) raw.write("event: error\ndata: log stream failed\n\n");
    } finally {
      clearInterval(heartbeat);
      raw.end();
    }
  });
};
