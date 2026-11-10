import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "./config.js";
import { streamLogs } from "./logs.js";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function config() {
  const dir = await mkdtemp(join(tmpdir(), "scad-logs-"));
  const configPath = join(dir, "config.json");
  await saveConfig({ apiUrl: "http://cp.test", pat: "pat-1" }, configPath);
  return configPath;
}

describe("scad logs (T1.7)", () => {
  it("prints each SSE data line, even when events are split across chunks", async () => {
    const configPath = await config();
    let url = "";
    let auth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      auth = new Headers(init?.headers).get("authorization");
      return sseResponse(["data: first\n\nda", "ta: sec", "ond\n\n: heartbeat\n\n", "event: end\ndata: \n\n"]);
    }) as typeof fetch;
    const lines: string[] = [];
    await streamLogs({ app: "board", follow: true, tail: 50, configPath, fetchImpl, onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["first", "second"]);
    expect(url).toBe("http://cp.test/v1/apps/board/logs?follow=1&tail=50");
    expect(auth).toBe("Bearer pat-1");
  });

  it("surfaces §8 errors", async () => {
    const configPath = await config();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ code: "NOT_FOUND", message: "App not found", hint: "h", details: {} }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await expect(
      streamLogs({ app: "nope", follow: false, configPath, fetchImpl, onLine: () => undefined }),
    ).rejects.toMatchObject({ envelope: { code: "NOT_FOUND" } });
  });
});
