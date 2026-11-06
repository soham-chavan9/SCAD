import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newId } from "@scad/shared";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider, VolumeQuotaExceededError } from "./docker-provider.js";
import { containerName, networkName, volumeName } from "./names.js";

const execFileAsync = promisify(execFile);
const COUNTER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../examples/counter-sqlite",
);
const PROBE_IMAGE = "busybox:1.36";
const limits = { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 };

/** Run a one-shot busybox container on the app's network or with its volume. */
async function oneShot(
  docker: Docker,
  opts: { cmd: string[]; network?: string; binds?: string[] },
): Promise<{ code: number; out: string }> {
  const c = await docker.createContainer({
    Image: PROBE_IMAGE,
    Cmd: opts.cmd,
    HostConfig: {
      NetworkMode: opts.network ?? "none",
      ...(opts.binds ? { Binds: opts.binds } : {}),
    },
  });
  try {
    await c.start();
    const { StatusCode } = await c.wait();
    const logs = await c.logs({ stdout: true, stderr: true });
    // Docker's 8-byte multiplexing headers are harmless for the regexes below.
    const out = String(logs);
    return { code: StatusCode, out };
  } finally {
    await c.remove({ force: true }).catch(() => undefined);
  }
}

/** GET the counter app from inside its own network; returns {count}. */
async function hit(docker: Docker, appId: string, path = "/"): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const { code, out } = await oneShot(docker, {
      network: networkName(appId),
      cmd: ["wget", "-qO-", "-T", "2", `http://${containerName(appId)}:8080${path}`],
    });
    const m = /"count":(\d+)/.exec(out);
    if (code === 0 && m?.[1]) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`counter app ${appId} never answered`);
}

describe("persistent /data volume (T1.3, real Docker)", () => {
  const docker = new Docker();
  // 1 "GB" = 1 MiB so the quota test writes a few MiB, not gigabytes.
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null, bytesPerDiskGb: 1024 * 1024 });
  const appIds: string[] = [];
  let imageRef: string;

  beforeAll(async () => {
    await execFileAsync("docker", ["pull", "-q", PROBE_IMAGE]);
    imageRef = "scad-test/counter-sqlite:t13";
    await execFileAsync("docker", ["build", "--network=none", "-q", "-t", imageRef, COUNTER_DIR], {
      maxBuffer: 10 * 1024 * 1024,
    });
  }, 240_000);

  afterAll(async () => {
    for (const id of appIds) {
      await provider.remove(id, { deleteVolume: true }).catch(() => undefined);
    }
  }, 120_000);

  it("counter survives stop/start and redeploy", async () => {
    const appId = newId();
    appIds.push(appId);
    await provider.ensureApp(appId, 1);
    let m = await provider.deploy({ appId, imageRef, port: 8080, env: {}, egressAllow: [], limits });
    expect(await hit(docker, appId)).toBe(1);
    expect(await hit(docker, appId)).toBe(2);

    await provider.stop(m);
    await provider.start(m);
    expect(await hit(docker, appId)).toBe(3);

    m = await provider.deploy({ appId, imageRef, port: 8080, env: { R: "2" }, egressAllow: [], limits });
    expect(await hit(docker, appId)).toBe(4);
  }, 240_000);

  it("remove with deleteVolume:false keeps data; deleteVolume:true wipes it", async () => {
    const appId = newId();
    appIds.push(appId);
    await provider.ensureApp(appId, 1);
    await provider.deploy({ appId, imageRef, port: 8080, env: {}, egressAllow: [], limits });
    expect(await hit(docker, appId)).toBe(1);

    await provider.remove(appId, { deleteVolume: false });
    await provider.ensureApp(appId, 1);
    await provider.deploy({ appId, imageRef, port: 8080, env: {}, egressAllow: [], limits });
    expect(await hit(docker, appId)).toBe(2);

    await provider.remove(appId, { deleteVolume: true });
    await provider.ensureApp(appId, 1);
    await provider.deploy({ appId, imageRef, port: 8080, env: {}, egressAllow: [], limits });
    expect(await hit(docker, appId)).toBe(1);
  }, 240_000);

  it("volume size limit: over-quota volumes refuse start/deploy and enforce stops a running app", async () => {
    const appId = newId();
    appIds.push(appId);
    await provider.ensureApp(appId, 2); // 2 "GB" = 2 MiB here
    const m = await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { ...limits, diskGb: 2 },
    });
    expect(await hit(docker, appId)).toBe(1);

    const usage = await provider.volumeUsage(appId);
    expect(usage.limitBytes).toBe(2 * 1024 * 1024);
    expect(usage.usedBytes).toBeLessThan(usage.limitBytes);
    expect(await provider.enforceVolumeQuota(m)).toBe("ok");

    // The app (or anything else) fills /data past the limit.
    const fill = await oneShot(docker, {
      binds: [`${volumeName(appId)}:/data`],
      cmd: ["dd", "if=/dev/zero", "of=/data/big", "bs=1024", "count=3072"],
    });
    expect(fill.code).toBe(0);

    expect(await provider.enforceVolumeQuota(m)).toBe("stopped");
    expect(await provider.status(m)).toBe("stopped");
    await expect(provider.start(m)).rejects.toBeInstanceOf(VolumeQuotaExceededError);
    await expect(
      provider.deploy({ appId, imageRef, port: 8080, env: {}, egressAllow: [], limits: { ...limits, diskGb: 2 } }),
    ).rejects.toMatchObject({ name: "VolumeQuotaExceededError", usedBytes: expect.any(Number) });
  }, 240_000);
});
