import type { Readable } from "node:stream";

/** Longest line kept before it is cut (protects the control plane from a newline-free flood). */
const MAX_LINE_CHARS = 16 * 1024;

/**
 * Incremental decoder for Docker's multiplexed log stream (8-byte header per
 * frame: stream id, 3 zero bytes, uint32 big-endian length). Frames and lines
 * may be split anywhere across chunks. Plain text (TTY containers) passes through.
 */
export function createLogDemuxer(): { push(chunk: Buffer): string[]; end(): string[] } {
  let pending: Buffer = Buffer.alloc(0);
  let mode: "unknown" | "mux" | "raw" = "unknown";
  let partial = "";

  function lines(text: string): string[] {
    const parts = (partial + text).split(/\r?\n/);
    partial = parts.pop() ?? "";
    if (partial.length > MAX_LINE_CHARS) {
      parts.push(partial.slice(0, MAX_LINE_CHARS));
      partial = "";
    }
    return parts.filter((p) => p.length > 0);
  }

  return {
    push(chunk: Buffer): string[] {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (mode === "unknown") {
        const first = pending[0] ?? 0;
        if (first > 2) {
          mode = "raw"; // A mux header starts with stream id 0, 1 or 2; text never does.
        } else if (pending.length < 4) {
          return [];
        } else {
          mode = pending[1] === 0 && pending[2] === 0 && pending[3] === 0 ? "mux" : "raw";
        }
      }
      if (mode === "raw") {
        const text = pending.toString("utf8");
        pending = Buffer.alloc(0);
        return lines(text);
      }
      const out: string[] = [];
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(4);
        if (pending.length < 8 + size) break;
        out.push(...lines(pending.subarray(8, 8 + size).toString("utf8")));
        pending = pending.subarray(8 + size);
      }
      return out;
    },
    end(): string[] {
      const rest = mode === "raw" || mode === "unknown" ? pending.toString("utf8") : "";
      pending = Buffer.alloc(0);
      const out = lines(rest);
      if (partial.length > 0) out.push(partial);
      partial = "";
      return out;
    },
  };
}

/** Decode Docker logs (a buffer, or a live stream) into text lines as they arrive. */
export async function* linesFromDockerLogs(data: Buffer | Readable): AsyncIterable<string> {
  const demux = createLogDemuxer();
  if (Buffer.isBuffer(data)) {
    yield* demux.push(data);
    yield* demux.end();
    return;
  }
  try {
    for await (const chunk of data) {
      yield* demux.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    yield* demux.end();
  } finally {
    // Consumer stopped early (client disconnected): close the Docker stream.
    data.destroy();
  }
}
