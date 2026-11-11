import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ScadApiError } from "@scad/api-client";
import { Builder } from "@scad/builder";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listEnv, loginWithDeviceCode, publishDir, setEnv } from "@scad/cli";
import Docker from "dockerode";
import { DockerRuntimeProvider, networkName } from "@scad/runtime-docker";
import { buildApp, type AppInstance } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { apps, machines, releases } from "./db/schema.js";
import { RuntimeLogCollector } from "./logs/collector.js";
import { recentRuntimeLogs } from "./logs/runtime-log-store.js";

const databaseUrl = process.env["DATABASE_URL"];
const execFileAsync = promisify(execFile);

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

      // T1.7b: the container's own output lands in SCAD's runtime log store.
      const collector = new RuntimeLogCollector({ db: dbBundle.db, runtime, flushMs: 50 });
      try {
        await collector.sweep();
        const deadline = Date.now() + 10_000;
        let lines: string[] = [];
        while (Date.now() < deadline) {
          await collector.flush();
          lines = (await recentRuntimeLogs(dbBundle.db, result.appId, 50)).map((r) => r.line);
          if (lines.some((l) => l.includes("hello-node listening"))) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(lines.some((l) => l.includes("hello-node listening"))).toBe(true);
      } finally {
        await collector.close();
      }
    },
    300_000,
  );

  // T2.4: no Dockerfile; SCAD's built-in templates build each layout offline.
  for (const layout of [
    { label: "a directory with only package.json", name: "pkg-only", dir: "pkg-only" },
    { label: "examples/hello-python (requirements.txt)", name: "hello-python", dir: "examples/hello-python" },
    { label: "examples/hello-static (index.html)", name: "hello-static", dir: "examples/hello-static" },
  ]) {
    it(
      `publishes ${layout.label} without a Dockerfile (T2.4)`,
      async () => {
        const dir =
          layout.dir === "pkg-only"
            ? await writeFixture(dataDir, {
                "package.json": JSON.stringify({
                  name: "pkg-only",
                  scripts: {
                    start:
                      "node -e \"require('http').createServer((q,r)=>r.end('pkg-only')).listen(process.env.PORT)\"",
                  },
                }),
              })
            : join(process.cwd(), layout.dir);
        const result = await publishDir({ dir, name: layout.name, configPath, pollMs: 300 });
        appIds.push(result.appId);
        const [release] = await dbBundle.db
          .select()
          .from(releases)
          .where(eq(releases.id, result.releaseId))
          .limit(1);
        expect(release?.status).toBe("ready");
        const [machine] = await dbBundle.db
          .select()
          .from(machines)
          .where(eq(machines.appId, result.appId))
          .limit(1);
        expect(
          await runtime.status({ appId: result.appId, providerId: machine!.providerId }),
        ).toBe("running");
      },
      300_000,
    );
  }

  /** Stay under the instance's 10-live-app limit (AGENTS §14): remove the app's container and retire its row. */
  async function retire(appId: string): Promise<void> {
    await runtime.remove(appId, { deleteVolume: true });
    await dbBundle.db.update(apps).set({ status: "deleted" }).where(eq(apps.id, appId));
  }

  // T3.2: one example per site framework family publishes with no Dockerfile
  // and no scad.json. Dependencies come from the trusted fetch step; the build
  // itself stays offline. Pages are fetched from inside the app's network.
  for (const site of [
    { name: "hello-vite", page: "/about", expect: "hello-vite" },
    { name: "hello-vue", page: "/", expect: "hello-vue" },
    { name: "hello-svelte", page: "/", expect: "hello-svelte" },
    { name: "hello-angular", page: "/about", expect: "hello-angular" },
    { name: "hello-astro", page: "/about/", expect: "hello-astro: about" },
    { name: "hello-docusaurus", page: "/second/", expect: "Second page" },
    { name: "hello-next-export", page: "/about", expect: "hello-next-export: about" },
    { name: "hello-gatsby", page: "/about/", expect: "hello-gatsby: about" },
    { name: "hello-hugo", page: "/about/", expect: "hello-hugo: About" },
    { name: "hello-jekyll", page: "/about/", expect: "hello-jekyll: about" },
  ]) {
    it(
      `publishes examples/${site.name} with no Dockerfile or scad.json, and ${site.page} loads (T3.2)`,
      async () => {
        const dir = join(process.cwd(), "examples", site.name);
        const result = await publishDir({ dir, name: site.name, configPath, pollMs: 500 });
        appIds.push(result.appId);
        const [release] = await dbBundle.db.select().from(releases).where(eq(releases.id, result.releaseId)).limit(1);
        expect(release?.status, JSON.stringify(release?.error)).toBe("ready");
        const [machine] = await dbBundle.db.select().from(machines).where(eq(machines.appId, result.appId)).limit(1);
        const ref = { appId: result.appId, providerId: machine!.providerId };
        expect(await runtime.status(ref)).toBe("running");
        const { host, port } = await runtime.address(ref);
        // A client-side or nested route answers 200 with the page (no 404 on reload).
        const { stdout } = await execFileAsync("docker", [
          "run", "--rm", "--network", networkName(result.appId), "busybox:1.36",
          "wget", "-q", "-O", "-", `http://${host}:${port}${site.page}`,
        ]);
        expect(stdout).toContain(site.expect);
        await retire(result.appId);
      },
      600_000,
    );
  }

  // T3.3: server-rendered sites publish with no Dockerfile, render on the
  // server, and come back from a stopped container within the 15 s wake budget.
  for (const site of ["hello-next", "hello-nuxt", "hello-sveltekit", "hello-remix", "hello-astro-ssr"]) {
    it(
      `publishes examples/${site}, renders on the server, and wakes within 15 s (T3.3)`,
      async () => {
        const dir = join(process.cwd(), "examples", site);
        const result = await publishDir({ dir, name: site, configPath, pollMs: 500 });
        appIds.push(result.appId);
        const [release] = await dbBundle.db.select().from(releases).where(eq(releases.id, result.releaseId)).limit(1);
        expect(release?.status, JSON.stringify(release?.error)).toBe("ready");
        const [machine] = await dbBundle.db.select().from(machines).where(eq(machines.appId, result.appId)).limit(1);
        const ref = { appId: result.appId, providerId: machine!.providerId };
        const get = async (path: string, waitSec = 0) => {
          const { host, port } = await runtime.address(ref);
          const url = `http://${host}:${port}${path}`;
          const script = `end=$(( $(date +%s) + ${waitSec} )); until wget -q -O - "$0"; do [ "$(date +%s)" -ge "$end" ] && exit 1; usleep 100000; done`;
          const { stdout } = await execFileAsync("docker", [
            "run", "--rm", "--network", networkName(result.appId), "busybox:1.36", "sh", "-c", script, url,
          ]);
          return stdout;
        };
        // The HTML comes from the server (not a client-only shell).
        expect(await get("/", 10)).toContain(`${site}: rendered on the server`);
        expect(await get("/about", 10)).toContain(`${site}: about`);

        await runtime.stop(ref);
        expect(await runtime.status(ref)).toBe("stopped");
        const t0 = Date.now();
        await runtime.start(ref);
        expect(await get("/", 15)).toContain("rendered on the server");
        expect(Date.now() - t0).toBeLessThan(15_000);

        const { apiUrl, pat } = (await loadConfig(configPath))!;
        const del = await fetch(`${apiUrl}/v1/apps/${result.appId}`, { method: "DELETE", headers: { authorization: `Bearer ${pat}` } });
        expect(del.ok).toBe(true);
      },
      600_000,
    );
  }

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
