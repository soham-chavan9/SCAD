import { newId } from "@scad/shared";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { networkName } from "./names.js";
import { ensureHttpEchoImage } from "./test-image.js";

async function pullImage(docker: Docker, image: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }
      docker.modem.followProgress(stream, (followErr: Error | null) => {
        if (followErr) {
          reject(followErr);
        } else {
          resolve();
        }
      });
    });
  });
}

/**
 * INV1 (partial): a container on app A's internal network cannot reach app B.
 * Full adversarial coverage lands in T2.8.
 */
describe("app network isolation", () => {
  const docker = new Docker();
  const provider = new DockerRuntimeProvider();
  const appIds: string[] = [];

  afterAll(async () => {
    for (const id of appIds) {
      try {
        await provider.remove(id, { deleteVolume: true });
      } catch {
        // ignore
      }
    }
  }, 120_000);

  it("deployed sample container is not reachable from another app network", async () => {
    const imageRef = await ensureHttpEchoImage();
    const appA = newId();
    const appB = newId();
    appIds.push(appA, appB);

    await provider.ensureApp(appA, 1);
    await provider.ensureApp(appB, 1);

    await provider.deploy({
      appId: appA,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });
    const machineB = await provider.deploy({
      appId: appB,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });

    const addrB = await provider.address(machineB);
    const target = `http://${addrB.host}:${addrB.port}/`;

    // Probe from a throwaway container attached only to app A's network.
    await pullImage(docker, "busybox:1.36");

    const probe = await docker.createContainer({
      Image: "busybox:1.36",
      Cmd: ["wget", "-T", "3", "-q", "-O", "-", target],
      HostConfig: {
        NetworkMode: networkName(appA),
        AutoRemove: false,
      },
    });

    await probe.start();
    const result = await probe.wait();
    const logs = await probe.logs({ stdout: true, stderr: true });
    await probe.remove({ force: true }).catch(() => undefined);

    expect(result.StatusCode, `wget logs: ${String(logs)}`).not.toBe(0);
  }, 180_000);

  it("rejects images that run as root (INV6 USER check)", async () => {
    const appId = newId();
    appIds.push(appId);
    await provider.ensureApp(appId, 1);
    await pullImage(docker, "busybox:1.36");

    await expect(
      provider.deploy({
        appId,
        imageRef: "busybox:1.36",
        port: 8080,
        env: {},
        egressAllow: [],
        limits: { memoryMb: 64, cpuShares: 128, diskGb: 1, pids: 32 },
      }),
    ).rejects.toThrow(/non-root/i);
  }, 120_000);
});
