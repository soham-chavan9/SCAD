import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ScadApiError } from "@scad/api-client";
import { Builder } from "@scad/builder";
import { randomBytes } from "node:crypto";
import { listEnv, loginWithDeviceCode, publishDir, setEnv } from "@scad/cli";
import Docker from "dockerode";
import { DockerRuntimeProvider } from "@scad/runtime-docker";
import { buildApp, type AppInstance } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { machines, releases } from "./db/schema.js";

const databaseUrl = process.env["DATABASE_URL"];

async function writeFixture(
  root: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(join(root, "fx-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

describe.runIf(Boolean(databaseUrl))("publish flow (T0.5)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let baseUrl: string;
  let dataDir: string;
  let configPath: string;
  let stopBuilder: (() => void) | undefined;
  const internalToken = "test-internal";
  const runtime = new DockerRuntimeProvider();
  const appIds: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    dataDir = await mkdtemp(join(tmpdir(), "scad-data-"));
    configPath = join(dataDir, "config.json");
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        env_vars, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);

    app = await buildApp({
      db: dbBundle.db,
      dataDir,
      baseDomain: "localhost:8080",
      publicBaseUrl: "http://127.0.0.1",
      operatorEmails: ["publisher@example.com"],
      internalToken,
      masterKeys: { current: randomBytes(32), previous: [] },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    await loginWithDeviceCode({
      apiUrl: baseUrl,
      approveEmail: "publisher@example.com",
      configPath,
      pollMs: 50,
    });

    const builder = new Builder({
      controlPlaneUrl: baseUrl,
      internalToken,
      runtime,
    });
    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        try {
          await builder.processNext();
        } catch {
          // ignore transient
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    void tick();
    stopBuilder = () => {
      stopped = true;
    };
  }, 120_000);

  afterAll(async () => {
    stopBuilder?.();
    for (const id of appIds) {
      try {
        await runtime.remove(id, { deleteVolume: true });
      } catch {
        // ignore
      }
    }
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await rm(dataDir, { recursive: true, force: true });
  }, 120_000);

  it(
    "scad publish examples/hello-node prints URL and container is running",
    async () => {
      const example = join(process.cwd(), "examples/hello-node");
      const result = await publishDir({
        dir: example,
        name: "hello-node",
        configPath,
        pollMs: 300,
      });

      expect(result.url).toBe("http://hello-node.publisher.localhost:8080");
      appIds.push(result.appId);

      const [machine] = await dbBundle.db
        .select()
        .from(machines)
        .where(eq(machines.appId, result.appId))
        .limit(1);
      expect(machine?.state).toBe("running");
      expect(machine?.providerId).toBeTruthy();

      const status = await runtime.status({
        appId: result.appId,
        providerId: machine!.providerId,
      });
      expect(status).toBe("running");

      const [release] = await dbBundle.db
        .select()
        .from(releases)
        .where(eq(releases.id, result.releaseId))
        .limit(1);
      expect(release?.status).toBe("ready");
    },
    300_000,
  );

  it(
    "scad.json drives port, start command, env, and resources (T1.5)",
    async () => {
      // CMD listens on 8080; only the manifest start argv moves it to 3000.
      const dir = await writeFixture(dataDir, {
        Dockerfile:
          "FROM node:22-alpine\nUSER node\nWORKDIR /home/node\nCOPY server.js .\nCMD [\"node\", \"server.js\"]\n",
        "server.js": [
          "const http = require('node:http');",
          "const port = process.argv.includes('--mode=manifest') ? 3000 : 8080;",
          "http.createServer((_q, r) => r.end(process.env.GREETING ?? 'none')).listen(port, '0.0.0.0');",
        ].join("\n"),
        "scad.json": JSON.stringify({
          name: "manifest-app",
          port: 3000,
          start: "node server.js --mode=manifest",
          env: { GREETING: "hi from scad.json" },
          resources: { memory_mb: 256 },
        }),
      });

      const result = await publishDir({ dir, name: "manifest-app", configPath, pollMs: 300 });
      appIds.push(result.appId);

      const [machine] = await dbBundle.db
        .select()
        .from(machines)
        .where(eq(machines.appId, result.appId))
        .limit(1);
      const info = await new Docker().getContainer(machine!.providerId).inspect();
      expect(info.State.Running).toBe(true);
      expect(info.Config.Entrypoint).toEqual(["node", "server.js", "--mode=manifest"]);
      expect(info.Config.Env).toContain("GREETING=hi from scad.json");
      expect(info.HostConfig.Memory).toBe(256 * 1024 * 1024);
      expect(Object.keys(info.Config.ExposedPorts ?? {})).toContain("3000/tcp");
    },
    300_000,
  );

  it(
    "a secret set with scad env is injected at container start, never into the build or logs (T1.6)",
    async () => {
      const secret = `sk-${randomBytes(12).toString("hex")}`;
      const example = join(process.cwd(), "examples/hello-node");
      await setEnv({ app: "hello-node", vars: { API_TOKEN: secret }, secret: true, configPath });
      expect(JSON.stringify(await listEnv({ app: "hello-node", configPath }))).not.toContain(secret);

      const result = await publishDir({ dir: example, name: "hello-node", configPath, pollMs: 300 });
      const [machine] = await dbBundle.db
        .select()
        .from(machines)
        .where(eq(machines.appId, result.appId))
        .limit(1);
      const info = await new Docker().getContainer(machine!.providerId).inspect();
      expect(info.Config.Env).toContain(`API_TOKEN=${secret}`);

      const logs = await fetch(`${baseUrl}/v1/releases/${result.releaseId}`, {
        headers: { authorization: `Bearer ${JSON.parse(await readFile(configPath, "utf8")).pat}` },
      });
      expect(await logs.text()).not.toContain(secret);
    },
    300_000,
  );

  it(
    "broken Dockerfile returns BUILD_FAILED with hint and log_tail",
    async () => {
      const dir = await writeFixture(dataDir, {
        Dockerfile: "FROM node:22-alpine\nRUN /bin/false\nUSER node\nCMD [\"node\"]\n",
        "server.js": "console.log('nope')\n",
        "scad.json": JSON.stringify({ name: "bad-build", port: 8080 }),
      });

      try {
        await publishDir({
          dir,
          name: "bad-build",
          configPath,
          pollMs: 300,
        });
        expect.fail("expected publish to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(ScadApiError);
        const envelope = (err as ScadApiError).envelope;
        expect(envelope).toMatchObject({
          code: "BUILD_FAILED",
          hint: expect.any(String),
        });
        if ("details" in envelope) {
          const tail = envelope.details["log_tail"];
          expect(Array.isArray(tail)).toBe(true);
          expect((tail as string[]).length).toBeGreaterThan(0);
        }
      }
    },
    300_000,
  );

  it(
    "app not listening returns PORT_NOT_LISTENING",
    async () => {
      const dir = await writeFixture(dataDir, {
        Dockerfile:
          "FROM node:22-alpine\nUSER node\nWORKDIR /home/node\nCOPY sleep.js .\nCMD [\"node\", \"sleep.js\"]\n",
        "sleep.js": "setInterval(() => {}, 1000);\n",
        "scad.json": JSON.stringify({ name: "no-listen", port: 8080 }),
      });

      try {
        await publishDir({
          dir,
          name: "no-listen",
          configPath,
          pollMs: 300,
        });
        expect.fail("expected publish to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(ScadApiError);
        const envelope = (err as ScadApiError).envelope;
        expect(envelope).toMatchObject({
          code: "PORT_NOT_LISTENING",
          hint: expect.any(String),
        });
      }
    },
    300_000,
  );
});
