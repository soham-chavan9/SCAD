import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DockerRuntimeProvider } from "@scad/runtime-docker";
import { newId } from "@scad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const docker = (...args: string[]) => execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../../../examples");
const NEIGHBOUR_IMAGE = "scad-test/inv6-neighbour:1";
const NEIGHBOUR_DOCKERFILE = [
  "FROM node:22-alpine",
  "USER node",
  `CMD ["node", "-e", "require('http').createServer((q, r) => r.end('neighbour-ok')).listen(8080)"]`,
  "",
].join("\n");

async function buildOffline(tag: string, dir: string): Promise<void> {
  await docker("build", "-q", "--network=none", "-t", tag, dir);
}

async function inspect(name: string): Promise<{ running: boolean; oomKilled: boolean }> {
  const { stdout } = await docker("inspect", "-f", "{{.State.Running}} {{.State.OOMKilled}}", name);
  const [running, oom] = stdout.trim().split(" ");
  return { running: running === "true", oomKilled: oom === "true" };
}

/** Current pid count of a container, from its cgroup (via `docker stats`). */
async function pidCount(name: string): Promise<number> {
  const { stdout } = await docker("stats", "--no-stream", "--format", "{{.PIDs}}", name);
  return Number.parseInt(stdout.trim(), 10);
}

/** HTTP GET from a throwaway busybox container on the app's network. */
async function getFromAppNet(network: string, host: string, port: number): Promise<string> {
  try {
    const { stdout } = await docker(
      "run", "--rm", "--network", network, "busybox:1.36",
      "wget", "-q", "-T", "3", "-O", "-", `http://${host}:${port}/`,
    );
    return stdout;
  } catch (err) {
    return `error: ${String((err as { stderr?: string }).stderr ?? err)}`;
  }
}

/**
 * INV6 (T2.2): a hostile app that exhausts pids or memory is contained by its
 * own limits. Its neighbour keeps serving and the Docker host stays usable.
 */
describe("resource exhaustion is contained (INV6, real Docker)", () => {
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null, egressProxyContainerName: null });
  const forkApp = newId();
  const hogApp = newId();
  const neighbourApp = newId();
  let neighbour = { network: "", host: "", port: 8080 };

  beforeAll(async () => {
    await buildOffline("scad-test/fork-bomb:1", join(EXAMPLES, "adversarial/fork-bomb"));
    await buildOffline("scad-test/memory-hog:1", join(EXAMPLES, "adversarial/memory-hog"));
    await execFileAsync("sh", ["-c", `printf '%s' "$DF" | docker build -q --network=none -t ${NEIGHBOUR_IMAGE} -`], {
      env: { ...process.env, DF: NEIGHBOUR_DOCKERFILE },
    });
    const n = await provider.deploy({
      appId: neighbourApp,
      imageRef: NEIGHBOUR_IMAGE,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 1024, diskGb: 1, pids: 64 },
    });
    const addr = await provider.address(n);
    neighbour = { network: `scad-net-${neighbourApp}`, host: addr.host, port: addr.port };
  }, 300_000);

  afterAll(async () => {
    for (const id of [forkApp, hogApp, neighbourApp]) {
      await provider.remove(id, { deleteVolume: true }).catch(() => undefined);
    }
  }, 180_000);

  it("fork bomb stays under its pids limit and the neighbour keeps serving", async () => {
    const pids = 64;
    const m = await provider.deploy({
      appId: forkApp,
      imageRef: "scad-test/fork-bomb:1",
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 256, cpuShares: 1024, diskGb: 1, pids },
    });
    // Give the bomb time to hit the ceiling.
    await new Promise((r) => setTimeout(r, 6000));
    const count = await pidCount(m.providerId);
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThanOrEqual(pids);
    expect(await getFromAppNet(neighbour.network, neighbour.host, neighbour.port)).toContain("neighbour-ok");
    // The host can still create and run containers while the bomb runs.
    const { stdout } = await docker("run", "--rm", "--network=none", "busybox:1.36", "echo", "host-ok");
    expect(stdout).toContain("host-ok");
  }, 120_000);

  it("memory hog is OOM-killed at its limit and the neighbour keeps serving", async () => {
    const m = await provider.deploy({
      appId: hogApp,
      imageRef: "scad-test/memory-hog:1",
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 64, cpuShares: 1024, diskGb: 1, pids: 64 },
    });
    let state = await inspect(m.providerId);
    const deadline = Date.now() + 60_000;
    while (state.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      state = await inspect(m.providerId);
    }
    expect(state.running, "memory hog must not keep running past its limit").toBe(false);
    expect(state.oomKilled, "the kernel OOM killer, not a crash, must stop it").toBe(true);
    expect(await getFromAppNet(neighbour.network, neighbour.host, neighbour.port)).toContain("neighbour-ok");
  }, 120_000);
});
