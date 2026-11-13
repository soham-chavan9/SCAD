import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScadApiError } from "@scad/api-client";
import { afterEach, describe, expect, it } from "vitest";
import { createScadMcpServer, TOOL_NAMES, type ScadMcpDeps } from "./server.js";

function fakeDeps(overrides: Partial<ScadMcpDeps> = {}): ScadMcpDeps & { calls: string[] } {
  const calls: string[] = [];
  const app = {
    id: "a1",
    slug: "demo",
    ownerId: "u1",
    status: "running",
    visibility: "allowlist",
    createdAt: "2026-11-08T00:00:00.000Z",
    expiresAt: null,
    lastViewedAt: null,
    url: "http://demo.me.localhost:8080",
  };
  return {
    calls,
    publish: async (dir, name, visibility) => {
      calls.push(`publish ${dir} ${name ?? ""}${visibility ? ` ${visibility}` : ""}`);
      const v = visibility ?? "allowlist";
      return {
        url: app.url,
        appId: "a1",
        releaseId: "r1",
        status: "ready",
        visibility: v,
        link: v === "public" ? "Public link: anyone with the link can open it." : "Private link: only people you share it with.",
      };
    },
    client: {
      listApps: async () => ({ apps: [app] }),
      getApp: async () => ({ app }),
      shareApp: async (a, email) => {
        calls.push(`share ${a} ${email}`);
        return { app_id: "a1", email };
      },
      unshareApp: async (_a, email) => ({ app_id: "a1", email, removed: true }),
      setEnv: async (a, changes, secret) => {
        calls.push(`env ${a} ${JSON.stringify(changes)} ${(secret ?? []).join(",")}`);
        return { env: [{ key: "K", secret: true }], applied: "redeployed" };
      },
      streamLogs: async (_a, _o, onLine) => {
        onLine("line 1");
        onLine("line 2");
      },
      deleteApp: async (a) => {
        calls.push(`delete ${a}`);
        return { app_id: "a1", slug: "demo", status: "deleted" };
      },
      rollback: async (a) => {
        calls.push(`rollback ${a}`);
        return {
          app_id: "a1",
          slug: "demo",
          url: app.url,
          release: { id: "r1", version: 1 },
          previous: { id: "r2", version: 2 },
          message: "Went back from version 2 to version 1. Saved data was not changed.",
        };
      },
    },
    ...overrides,
  };
}

let client: Client | undefined;

async function connect(deps: ScadMcpDeps): Promise<Client> {
  const server = createScadMcpServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function text(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join("\n");
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("SCAD MCP server (T1.8)", () => {
  it("exposes exactly the listed tools, each describing purpose, inputs, and errors", async () => {
    const c = await connect(fakeDeps());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(80);
      expect(tool.description).toMatch(/Errors?:/);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("publish returns the URL as JSON", async () => {
    const deps = fakeDeps();
    const c = await connect(deps);
    const result = await c.callTool({ name: "publish", arguments: { dir: "/tmp/app", name: "demo" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ url: "http://demo.me.localhost:8080", app_id: "a1" });
    expect(deps.calls).toContain("publish /tmp/app demo");
  });

  it("passes the §8 error envelope through, including hint and log_tail", async () => {
    const envelope = {
      code: "BUILD_FAILED" as const,
      message: "docker build failed",
      hint: "Builds run without network access.",
      details: { log_tail: ["RUN wget http://x", "wget: bad address 'x'"] },
    };
    const c = await connect(
      fakeDeps({
        publish: async () => {
          throw new ScadApiError(400, envelope);
        },
      }),
    );
    const result = await c.callTool({ name: "publish", arguments: { dir: "/tmp/app" } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual(envelope);
  });

  it("non-API failures still come back as an envelope with a hint", async () => {
    const c = await connect(
      fakeDeps({
        publish: async () => {
          throw new Error("Not logged in. Run `scad login` first.");
        },
      }),
    );
    const result = await c.callTool({ name: "publish", arguments: { dir: "/tmp/app" } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ code: "INTERNAL", hint: expect.any(String) });
  });

  it("share, set_env, and get_logs call through to the API", async () => {
    const deps = fakeDeps();
    const c = await connect(deps);
    await c.callTool({ name: "share", arguments: { app: "demo", email: "friend@example.com" } });
    await c.callTool({
      name: "set_env",
      arguments: { app: "demo", vars: { K: "v", OLD: null }, secret: ["K"] },
    });
    const logs = await c.callTool({ name: "get_logs", arguments: { app: "demo", tail: 2 } });
    expect(deps.calls).toContain("share demo friend@example.com");
    expect(deps.calls).toContain('env demo {"K":"v","OLD":null} K');
    expect(JSON.parse(text(logs))).toEqual({ lines: ["line 1", "line 2"] });
  });

  it("set_env never echoes values back", async () => {
    const c = await connect(fakeDeps());
    const result = await c.callTool({
      name: "set_env",
      arguments: { app: "demo", vars: { K: "super-secret-value" }, secret: ["K"] },
    });
    expect(text(result)).not.toContain("super-secret-value");
  });

  it("delete_app refuses without confirm: true", async () => {
    const deps = fakeDeps();
    const c = await connect(deps);
    const refused = await c.callTool({ name: "delete_app", arguments: { app: "demo" } });
    expect(refused.isError).toBe(true);
    expect(deps.calls.some((x) => x.startsWith("delete"))).toBe(false);
    const ok = await c.callTool({ name: "delete_app", arguments: { app: "demo", confirm: true } });
    expect(ok.isError).toBeFalsy();
    expect(deps.calls).toContain("delete demo");
  });

  it("rejects bad input", async () => {
    const c = await connect(fakeDeps());
    const result = await c.callTool({ name: "share", arguments: { app: "demo", email: "not-an-email" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/email/i);
  });

  it("rollback goes back one version in one call (T3.6)", async () => {
    const deps = fakeDeps();
    const c = await connect(deps);
    const result = await c.callTool({ name: "rollback", arguments: { app: "demo" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ release: { version: 1 }, message: expect.stringMatching(/version 1/) });
    expect(deps.calls).toContain("rollback demo");
  });

  it("publish asks private or public, defaults to private, and says which link it made (T3.5)", async () => {
    const deps = fakeDeps();
    const c = await connect(deps);
    const { tools } = await c.listTools();
    const publish = tools.find((t) => t.name === "publish");
    expect(publish?.description).toMatch(/ask the person/i);
    expect(publish?.description).toMatch(/private \(only people you share it with\) or public \(anyone with the link\)/);
    expect(publish?.description).toMatch(/no clear answer, use "private"/);
    const schema = publish?.inputSchema as { properties: { visibility: { enum: string[] } }; required?: string[] };
    expect(schema.properties.visibility.enum).toEqual(["private", "public"]);
    expect(schema.required ?? []).not.toContain("visibility");

    const unsaid = await c.callTool({ name: "publish", arguments: { dir: "/tmp/app", name: "demo" } });
    expect(JSON.parse(text(unsaid))).toMatchObject({ visibility: "private", link: expect.stringMatching(/^Private link/) });
    expect(deps.calls).toContain("publish /tmp/app demo");

    const pub = await c.callTool({ name: "publish", arguments: { dir: "/tmp/app", name: "demo", visibility: "public" } });
    expect(JSON.parse(text(pub))).toMatchObject({ visibility: "public", link: expect.stringMatching(/^Public link/) });
    expect(deps.calls).toContain("publish /tmp/app demo public");

    const priv = await c.callTool({ name: "publish", arguments: { dir: "/tmp/app", name: "demo", visibility: "private" } });
    expect(JSON.parse(text(priv))).toMatchObject({ visibility: "private" });
    expect(deps.calls).toContain("publish /tmp/app demo allowlist");
  });
});
