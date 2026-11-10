import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "./config.js";
import { listApps, listShares, setVisibility, shareApp, unshareApp } from "./share.js";

type Call = { method: string; url: string; body: unknown; auth: string | null };

async function setup(responses: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "scad-share-"));
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
      auth: new Headers(init?.headers).get("authorization"),
    });
    const key = `${method} ${url.replace("http://cp.test", "")}`;
    const body = responses[key];
    if (body === undefined) return new Response(JSON.stringify({ code: "NOT_FOUND", message: "x", hint: "y", details: {} }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { configPath, calls, fetchImpl };
}

describe("scad share / unshare / ls (T1.2)", () => {
  it("share POSTs the email to the app's share route with the PAT", async () => {
    const { configPath, calls, fetchImpl } = await setup({
      "POST /v1/apps/board/share": { app_id: "a1", email: "friend@example.com" },
    });
    const out = await shareApp({ app: "board", email: "friend@example.com", configPath, fetchImpl });
    expect(out.email).toBe("friend@example.com");
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { email: "friend@example.com" },
      auth: "Bearer pat-1",
    });
  });

  it("unshare DELETEs with the email URL-encoded", async () => {
    const { configPath, calls, fetchImpl } = await setup({
      "DELETE /v1/apps/board/share/a%2Bb%40example.com": { app_id: "a1", email: "a+b@example.com", removed: true },
    });
    const out = await unshareApp({ app: "board", email: "a+b@example.com", configPath, fetchImpl });
    expect(out.removed).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
  });

  it("ls lists apps; ls <app> lists viewers", async () => {
    const { configPath, fetchImpl } = await setup({
      "GET /v1/apps": { apps: [{ id: "a1", slug: "board", status: "running", visibility: "allowlist", url: "http://board.olive.localhost:8080" }] },
      "GET /v1/apps/board/share": { app_id: "a1", visibility: "allowlist", viewers: [{ email: "friend@example.com", granted_at: "2026-11-06T00:00:00.000Z" }] },
    });
    const apps = await listApps({ configPath, fetchImpl });
    expect(apps.map((a) => a.slug)).toEqual(["board"]);
    const shares = await listShares({ app: "board", configPath, fetchImpl });
    expect(shares.viewers.map((v) => v.email)).toEqual(["friend@example.com"]);
  });

  it("share --instance PATCHes visibility", async () => {
    const { configPath, calls, fetchImpl } = await setup({
      "PATCH /v1/apps/board": { app: { id: "a1", slug: "board", visibility: "instance" } },
    });
    const out = await setVisibility({ app: "board", visibility: "instance", configPath, fetchImpl });
    expect(out.visibility).toBe("instance");
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { visibility: "instance" } });
  });
});
