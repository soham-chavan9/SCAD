import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { newId } from "@scad/shared";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { ensureHttpEchoImage } from "./test-image.js";

const execFileAsync = promisify(execFile);

async function buildFromString(tag: string, dockerfile: string): Promise<void> {
  await execFileAsync("sh", ["-c", `printf '%s' "$DF" | docker build -q --network=none -t ${tag} -`], {
    env: { ...process.env, DF: dockerfile },
  });
}

/**
 * Answers 200 only if it could NOT reach the host or the internet during
 * startup; otherwise 500 (smoke failure). On Docker's default bridge this
 * app fails smoke, on an internal app network it passes.
 */
const LEAK_PROBE_IMAGE = "scad-test/smoke-leak-probe:1";
const LEAK_PROBE_DOCKERFILE = [
  "FROM node:22-alpine",
  "USER node",
  "WORKDIR /home/node",
  `RUN printf '%s' "${[
    "const net = require('net');",
    "const targets = [['1.1.1.1', 53], ['host.docker.internal', 80], ['172.17.0.1', 80]];",
    "const reach = ([h, p]) => new Promise((ok) => { const s = net.connect(p, h);",
    " s.setTimeout(2000, () => { s.destroy(); ok(null); });",
    " s.on('connect', () => { s.destroy(); ok(h); });",
    " s.on('error', (e) => ok(e.code === 'ECONNREFUSED' ? h : null)); });",
    "Promise.all(targets.map(reach)).then((r) => { const leaked = r.filter(Boolean);",
    " require('http').createServer((q, res) => { res.statusCode = leaked.length ? 500 : 200;",
    " res.end(leaked.length ? 'leaked:' + leaked.join(',') : 'sealed'); }).listen(8080); });",
  ].join("")}" > server.js`,
  `CMD ["node", "server.js"]`,
  "",
].join("\n");

const SILENT_IMAGE = "scad-test/smoke-silent:1";
const SILENT_DOCKERFILE = [
  "FROM node:22-alpine",
  "USER node",
  `CMD ["node", "-e", "setInterval(() => {}, 1000)"]`,
  "",
].join("\n");

const ROOT_IMAGE = "scad-test/smoke-root:1";
const ROOT_DOCKERFILE = [
  "FROM node:22-alpine",
  `CMD ["node", "-e", "require('http').createServer((q, r) => r.end('x')).listen(8080)"]`,
  "",
].join("\n");

const limits = { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 };

/** T2.2: the builder's smoke check runs with the deploy's isolation and hardening. */
describe("smokeCheck (real Docker)", () => {
  const docker = new Docker();
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null, egressProxyContainerName: null });
  const appIds: string[] = [];

  beforeAll(async () => {
    await buildFromString(LEAK_PROBE_IMAGE, LEAK_PROBE_DOCKERFILE);
    await buildFromString(SILENT_IMAGE, SILENT_DOCKERFILE);
    await buildFromString(ROOT_IMAGE, ROOT_DOCKERFILE);
  }, 300_000);

  afterAll(async () => {
    for (const id of appIds) await provider.remove(id, { deleteVolume: true }).catch(() => undefined);
  }, 120_000);

  const spec = (imageRef: string) => {
    const appId = newId();
    appIds.push(appId);
    return { appId, imageRef, port: 8080, env: {}, egressAllow: [], limits };
  };

  const smokeContainers = async (appId: string) =>
    docker.listContainers({
      all: true,
      filters: { label: [`scad.app_id=${appId}`, "scad.role=smoke"] },
    });

  it("passes for a healthy app and leaves no container behind", async () => {
    const s = spec(await ensureHttpEchoImage());
    await provider.smokeCheck(s, { timeoutMs: 20_000 });
    expect(await smokeContainers(s.appId)).toHaveLength(0);
  }, 120_000);

  it("control: on Docker's default bridge the same probe does report a leak", async () => {
    const name = `scad-smoke-control-${newId().slice(0, 8)}`;
    await execFileAsync("docker", ["run", "-d", "--name", name, LEAK_PROBE_IMAGE]);
    try {
      const { stdout: ip } = await execFileAsync("docker", [
        "inspect", "-f", "{{.NetworkSettings.Networks.bridge.IPAddress}}", name,
      ]);
      let body = "";
      for (let i = 0; i < 20 && !/ 500 |^leaked:/.test(body); i++) {
        await new Promise((r) => setTimeout(r, 500));
        const res = await execFileAsync("docker", [
          "run", "--rm", "busybox:1.36", "sh", "-c",
          'wget -q -T 2 -O - "http://$0:8080/" 2>&1 || true', ip.trim(),
        ]);
        body = res.stdout.trim();
      }
      // busybox wget prints the status line, not the body, for a 500.
      expect(body).toMatch(/ 500 |^leaked:/);
    } finally {
      await execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
    }
  }, 60_000);

  it("the app under smoke cannot reach the host or the internet (internal app network)", async () => {
    const s = spec(LEAK_PROBE_IMAGE);
    await expect(provider.smokeCheck(s, { timeoutMs: 20_000 })).resolves.toBeUndefined();
  }, 120_000);

  it("fails when nothing listens, and cleans up", async () => {
    const s = spec(SILENT_IMAGE);
    await expect(provider.smokeCheck(s, { timeoutMs: 4_000 })).rejects.toThrow(/did not become ready/);
    expect(await smokeContainers(s.appId)).toHaveLength(0);
  }, 120_000);

  it("refuses a root image before running it (INV6)", async () => {
    const s = spec(ROOT_IMAGE);
    await expect(provider.smokeCheck(s, { timeoutMs: 4_000 })).rejects.toThrow(/non-root USER/);
  }, 60_000);
});
