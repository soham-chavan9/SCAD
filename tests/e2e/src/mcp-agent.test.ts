import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScadClient } from "@scad/api-client";
import { Builder } from "@scad/builder";
import { loginWithDeviceCode, loadConfig, publishDir } from "@scad/cli";
import { assertTruncateAllowed, buildApp, createDb, runMigrations, type Db } from "@scad/control-plane";
import { createScadMcpServer } from "@scad/mcp-server";
import { containerName, DockerRuntimeProvider, networkName } from "@scad/runtime-docker";

const databaseUrl = process.env["DATABASE_URL"];
/** Repo root, independent of the working directory vitest runs from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const execFileAsync = promisify(execFile);

/** GET a path from inside the app's own network (apps are not reachable from the host). */
async function getFromApp(appId: string, path = "/"): Promise<string> {
  let last = "";
  for (let i = 0; i < 40; i++) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "run", "--rm", "--network", networkName(appId), "busybox:1.36",
        "wget", "-qO-", "-T", "2", `http://${containerName(appId)}:8080${path}`,
      ]);
      return stdout;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`app ${appId} never answered: ${last.slice(0, 200)}`);
}

type ToolText = { content: { type: string; text: string }[]; isError?: boolean };

/**
 * T1.8 acceptance: a scripted agent publishes and shares using only MCP tools,
 * and recovers from a forced build error using only `hint` + `log_tail`.
 */
describe.runIf(Boolean(databaseUrl))("MCP agent session (T1.8, real Docker)", () => {
  let dbBundle: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;
  let mcp: Client;
  let stopBuilder = () => {};
  const runtime = new DockerRuntimeProvider();
  const appIds: string[] = [];

  async function call(name: string, args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name, arguments: args })) as ToolText;
    const body = JSON.parse(result.content.map((c) => c.text).join("\n")) as Record<string, unknown>;
    return { isError: result.isError === true, body };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    dataDir = await mkdtemp(join(tmpdir(), "scad-mcp-"));
    const configPath = join(dataDir, "config.json");
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        runtime_logs, env_vars, app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const internalToken = "mcp-internal";
    app = await buildApp({
      db: dbBundle.db,
      dataDir,
      baseDomain: "localhost:8080",
      publicBaseUrl: "http://127.0.0.1",
      operatorEmails: ["agent@example.com"],
      internalToken,
      runtime,
      masterKeys: { current: randomBytes(32), previous: [] },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const apiUrl = `http://127.0.0.1:${addr.port}`;
    await loginWithDeviceCode({ apiUrl, approveEmail: "agent@example.com", configPath, pollMs: 50 });
    const config = await loadConfig(configPath);
    if (!config) throw new Error("login failed");

    const builder = new Builder({ controlPlaneUrl: apiUrl, internalToken, runtime });
    let stopped = false;
    void (async () => {
      while (!stopped) {
        await builder.processNext().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    stopBuilder = () => {
      stopped = true;
    };

    const server = createScadMcpServer({
      client: new ScadClient({ baseUrl: config.apiUrl, pat: config.pat }),
      publish: (dir, name, visibility) =>
        publishDir({
          dir,
          ...(name ? { name } : {}),
          ...(visibility ? { visibility } : {}),
          apiUrl: config.apiUrl,
          pat: config.pat,
          pollMs: 300,
        }),
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    mcp = new Client({ name: "scripted-agent", version: "0.0.0" });
    await mcp.connect(clientT);
  }, 120_000);

  afterAll(async () => {
    stopBuilder();
    await mcp?.close();
    for (const id of appIds) await runtime.remove(id, { deleteVolume: true }).catch(() => undefined);
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await rm(dataDir, { recursive: true, force: true });
  }, 120_000);

  it(
    "publishes examples/hello-node and shares it using only MCP tools",
    async () => {
      const published = await call("publish", { dir: join(REPO_ROOT, "examples/hello-node"), name: "hello-node" });
      expect(published.isError).toBe(false);
      expect(published.body).toMatchObject({ url: "http://hello-node.agent.localhost:8080" });
      // T3.5: nobody said public, so the link is private, and the result says so.
      expect(published.body).toMatchObject({ visibility: "private", link: expect.stringMatching(/^Private link/) });
      appIds.push(String(published.body["app_id"]));

      const shared = await call("share", { app: "hello-node", email: "friend@example.com" });
      expect(shared.isError).toBe(false);

      const detail = await call("get_app", { app: "hello-node" });
      expect(detail.body).toMatchObject({ app: { slug: "hello-node", status: "running" }, viewers: ["friend@example.com"] });

      const list = await call("list_apps", {});
      expect((list.body["apps"] as { slug: string }[]).map((a) => a.slug)).toContain("hello-node");
    },
    300_000,
  );

  it(
    "recovers from a forced build error using only hint and log_tail",
    async () => {
      const dir = await mkdtemp(join(dataDir, "broken-"));
      await writeFile(
        join(dir, "Dockerfile"),
        [
          "FROM node:22-alpine",
          "WORKDIR /home/node",
          "RUN wget -q -O /tmp/dep.tgz https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          "COPY server.js .",
          "USER node",
          'CMD ["node", "server.js"]',
          "",
        ].join("\n"),
      );
      await writeFile(
        join(dir, "server.js"),
        "require('http').createServer((q, r) => r.end('ok')).listen(8080);\n",
      );

      // Attempt 1 fails: builds have no network.
      const first = await call("publish", { dir, name: "agent-fix" });
      expect(first.isError).toBe(true);
      expect(first.body).toMatchObject({ code: "BUILD_FAILED" });
      const hint = String(first.body["hint"]);
      const logTail = (first.body["details"] as { log_tail: string[] }).log_tail;
      expect(hint).toMatch(/network/i);
      expect(logTail.length).toBeGreaterThan(0);

      // The "agent" acts only on what the error told it: the hint says builds
      // can't download, and log_tail names the RUN step that tried to.
      const dockerfile = await readFile(join(dir, "Dockerfile"), "utf8");
      const offending = dockerfile
        .split("\n")
        .filter((line) => line.startsWith("RUN ") && logTail.some((l) => l.includes(line.slice(4, 40))));
      expect(offending).toHaveLength(1);
      await writeFile(
        join(dir, "Dockerfile"),
        dockerfile
          .split("\n")
          .filter((line) => !offending.includes(line))
          .join("\n"),
      );

      // Attempt 2 succeeds.
      const second = await call("publish", { dir, name: "agent-fix" });
      expect(second.isError).toBe(false);
      expect(second.body).toMatchObject({ url: "http://agent-fix.agent.localhost:8080" });
      appIds.push(String(second.body["app_id"]));
    },
    300_000,
  );

  it(
    "undoes a broken update with the rollback tool and keeps /data (T3.6)",
    async () => {
      const dir = await mkdtemp(join(dataDir, "undo-"));
      await cp(join(REPO_ROOT, "examples/counter-sqlite"), dir, { recursive: true });

      const v1 = await call("publish", { dir, name: "undo-demo" });
      expect(v1.isError).toBe(false);
      const appId = String(v1.body["app_id"]);
      appIds.push(appId);
      // The builder's smoke check may already have counted a visit.
      const count = async (path: string) => (JSON.parse(await getFromApp(appId, path)) as { count: number }).count;
      const before = await count("/peek");
      expect(await count("/")).toBe(before + 1);

      // The "broken" update: it builds and runs, but serves the wrong thing.
      const server = await readFile(join(dir, "server.js"), "utf8");
      await writeFile(
        join(dir, "server.js"),
        server.replace("res.end(JSON.stringify({ count: row.n }));", 'res.end("oops, broken");'),
      );
      const v2 = await call("publish", { dir, name: "undo-demo" });
      expect(v2.isError).toBe(false);
      expect(await getFromApp(appId)).toBe("oops, broken");

      // "That update broke it, go back."
      const undo = await call("rollback", { app: "undo-demo" });
      expect(undo.isError).toBe(false);
      expect(undo.body).toMatchObject({ release: { version: 1 }, previous: { version: 2 } });
      // Old code again, and the /data counter kept going: the broken release's
      // visit counted too, so nothing was reset by either deploy.
      const after = await count("/peek");
      expect(after).toBeGreaterThanOrEqual(before + 2);
      expect(await count("/")).toBe(after + 1);

      // Nothing earlier than v1: the tool says so with a hint.
      const again = await call("rollback", { app: "undo-demo" });
      expect(again.isError).toBe(true);
      expect(again.body).toMatchObject({ code: "VALIDATION_FAILED", hint: expect.stringMatching(/publish again/) });
    },
    300_000,
  );
});
