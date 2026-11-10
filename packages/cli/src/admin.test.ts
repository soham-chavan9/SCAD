import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adminAudit,
  adminInviteAdd,
  adminInviteRemove,
  adminInvites,
  adminSuspendApp,
  adminSuspendUser,
  adminUsage,
  adminUsers,
  formatUsage,
} from "./admin.js";
import { saveConfig } from "./config.js";

type Call = { method: string; url: string; body: unknown };

async function setup(responses: Record<string, { status?: number; body: unknown }>) {
  const dir = await mkdtemp(join(tmpdir(), "scad-admin-"));
  const configPath = join(dir, "config.json");
  await saveConfig({ apiUrl: "http://cp.test", pat: "pat-op" }, configPath);
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace("http://cp.test", "");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const r = responses[`${method} ${url}`] ?? {
      status: 404,
      body: { code: "NOT_FOUND", message: "x", hint: "y", details: {} },
    };
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { configPath, calls, fetchImpl };
}

describe("scad admin (T2.6)", () => {
  it("suspend-app sends the owner/slug ref URL-encoded", async () => {
    const { configPath, calls, fetchImpl } = await setup({
      "POST /v1/admin/apps/olive%2Fboard/suspend": {
        body: { app: { id: "a1", slug: "board", owner: "olive", status: "suspended" } },
      },
    });
    const out = await adminSuspendApp({
      app: "olive/board",
      suspended: true,
      configPath,
      fetchImpl,
    });
    expect(out.status).toBe("suspended");
    expect(calls[0]?.method).toBe("POST");
  });

  it("unsuspend-user and users hit the operator routes", async () => {
    const user = {
      id: "u1",
      email: "a@b.co",
      handle: "a",
      role: "member",
      status: "active",
      created_at: "x",
    };
    const { configPath, fetchImpl } = await setup({
      "POST /v1/admin/users/a%40b.co/unsuspend": { body: { user } },
      "GET /v1/admin/users": { body: { users: [user] } },
    });
    expect(
      (await adminSuspendUser({ user: "a@b.co", suspended: false, configPath, fetchImpl })).status,
    ).toBe("active");
    expect(await adminUsers({ configPath, fetchImpl })).toHaveLength(1);
  });

  it("invite add / rm / ls", async () => {
    const { configPath, calls, fetchImpl } = await setup({
      "POST /v1/admin/invites": { status: 201, body: { email: "f@x.co", created: true } },
      "DELETE /v1/admin/invites/f%40x.co": { body: { email: "f@x.co", removed: true } },
      "GET /v1/admin/invites": {
        body: { invites: [{ email: "f@x.co", invited_by: null, created_at: "x" }] },
      },
    });
    expect((await adminInviteAdd({ email: "f@x.co", configPath, fetchImpl })).created).toBe(true);
    expect(calls[0]?.body).toEqual({ email: "f@x.co" });
    expect((await adminInviteRemove({ email: "f@x.co", configPath, fetchImpl })).removed).toBe(
      true,
    );
    expect(await adminInvites({ configPath, fetchImpl })).toHaveLength(1);
  });

  it("audit passes limit and app filters", async () => {
    const { configPath, fetchImpl } = await setup({
      "GET /v1/admin/audit?limit=5&app=olive%2Fboard": { body: { events: [] } },
    });
    expect(await adminAudit({ limit: 5, app: "olive/board", configPath, fetchImpl })).toEqual([]);
  });

  it("a non-operator gets the 403 envelope as an error", async () => {
    const { configPath, fetchImpl } = await setup({
      "GET /v1/admin/users": {
        status: 403,
        body: { code: "FORBIDDEN", message: "Operator only", hint: "OPERATOR_EMAILS", details: {} },
      },
    });
    await expect(adminUsers({ configPath, fetchImpl })).rejects.toMatchObject({
      envelope: { code: "FORBIDDEN" },
    });
  });

  it("usage (T2.7) asks for the window and prints one line per app plus totals", async () => {
    const report = {
      window_days: 7,
      since: "2026-11-04",
      generated_at: "2026-11-10T12:00:00.000Z",
      apps: [
        {
          id: "a1",
          owner: "olive",
          slug: "board",
          status: "running",
          pinned: true,
          requests: 42,
          unique_viewers: 3,
          last_viewed_at: "2026-11-10T11:00:00.000Z",
          running_hours: 5.5,
          volume_bytes: 12 * 1024 * 1024,
          volume_measured_at: "2026-11-10T11:55:00.000Z",
          expires_at: null,
        },
      ],
      totals: { apps: 1, running: 1, requests: 42, running_hours: 5.5, volume_bytes: 12 * 1024 * 1024 },
    };
    const { configPath, fetchImpl } = await setup({ "GET /v1/admin/usage?days=7": { body: report } });
    const out = await adminUsage({ days: 7, configPath, fetchImpl });
    const text = formatUsage(out);
    expect(text).toMatch(/^APP\s+STATUS\s+REQUESTS\s+VIEWERS\s+LAST VIEWED\s+RUN HOURS\s+VOLUME/);
    expect(text).toMatch(/olive\/board\s+running \(pinned\)\s+42\s+3\s+2026-11-10 11:00\s+5\.50\s+12\.0 MB/);
    expect(text).toContain("1 apps (1 running), 42 requests in 7 days, 5.50 running hours, 12.0 MB on volumes");
  });
});
