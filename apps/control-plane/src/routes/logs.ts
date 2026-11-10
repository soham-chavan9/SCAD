import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { ApiError } from "../errors.js";
import type { MachineController } from "../machines/controller.js";
import { findOwnedApp } from "./share.js";

export type LogsRoutesOpts = {
  db: Db["db"];
  machines?: MachineController;
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
  /** §8: SSE runtime log. Owner only (INV10); shared viewers get 404 like strangers. */
  app.get<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug/logs", async (request, reply) => {
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_FAILED", "Invalid logs query", "Use ?follow=1 and ?tail=N (0 to 10000).");
    }
    if (!opts.machines) {
      throw new ApiError(503, "INTERNAL", "Logs are not available on this instance", "Start the control plane with a runtime.");
    }
    const follow = parsed.data.follow === "1" || parsed.data.follow === "true";
    // Throws NOT_FOUND (no machine yet) before any bytes are sent.
    const lines = await opts.machines.logs(owned.id, { follow, tail: parsed.data.tail });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const iterator = lines[Symbol.asyncIterator]();
    let closed = false;
    raw.on("close", () => {
      closed = true;
      // Ends the runtime stream once its pending read settles.
      void iterator.return?.();
    });
    const heartbeat = follow ? setInterval(() => raw.write(": keepalive\n\n"), HEARTBEAT_MS) : undefined;

    try {
      while (!closed) {
        const next = await iterator.next();
        if (next.done) break;
        if (!closed) raw.write(sseData(next.value));
      }
      if (!closed) raw.write("event: end\ndata: \n\n");
    } catch {
      if (!closed) raw.write("event: error\ndata: log stream failed\n\n");
    } finally {
      clearInterval(heartbeat);
      raw.end();
    }
  });
};
