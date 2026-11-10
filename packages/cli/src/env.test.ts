import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "./config.js";
import { listEnv, parseAssignments, setEnv, unsetEnv } from "./env.js";

type Call = { method: string; url: string; body: unknown };

async function setup(responses: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "scad-env-"));
  const configPath = join(dir, "config.json");
  await saveConfig({ apiUrl: "http://cp.test", pat: "pat-1" }, configPath);
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const body = responses[`${method} ${url.replace("http://cp.test", "")}`];
    if (body === undefined) {
      return new Response(JSON.stringify({ code: "NOT_FOUND", message: "x", hint: "y", details: {} }), { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { configPath, calls, fetchImpl };
}

describe("scad env (T1.6)", () => {
  it("parses KEY=value, splitting at the first =", () => {
    expect(parseAssignments(["A=1", "URL=postgres://u:p@h/db?x=y", "EMPTY="])).toEqual({
      A: "1",
      URL: "postgres://u:p@h/db?x=y",
      EMPTY: "",
    });
    expect(() => parseAssignments(["NOEQUALS"])).toThrow(/KEY=value/);
    expect(() => parseAssignments([])).toThrow();
  });

  it("set PUTs the values and marks them secret with --secret", async () => {
    const { configPath, calls, fetchImpl } = await setup({
      "PUT /v1/apps/board/env": { env: [], applied: "redeployed" },
    });
    await setEnv({ app: "board", vars: { API_TOKEN: "t" }, secret: true, configPath, fetchImpl });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      body: { API_TOKEN: "t", secret: ["API_TOKEN"] },
    });
  });

  it("unset sends null for each key", async () => {
    const { configPath, calls, fetchImpl } = await setup({
      "PUT /v1/apps/board/env": { env: [], applied: "next_start" },
    });
    await unsetEnv({ app: "board", keys: ["A", "B"], configPath, fetchImpl });
    expect(calls[0]?.body).toEqual({ A: null, B: null });
  });

  it("ls returns keys; secret values are never present", async () => {
    const { configPath, fetchImpl } = await setup({
      "GET /v1/apps/board/env": { env: [{ key: "A", secret: false, value: "1" }, { key: "T", secret: true }] },
    });
    expect(await listEnv({ app: "board", configPath, fetchImpl })).toEqual([
      { key: "A", secret: false, value: "1" },
      { key: "T", secret: true },
    ]);
  });
});
