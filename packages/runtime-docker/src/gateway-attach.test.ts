import { newId } from "@scad/shared";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { networkName } from "./names.js";
import { ensureHttpEchoImage } from "./test-image.js";

const GATEWAY_NAME = `scad-gateway-test-${process.pid}`;

/**
 * On deploy, the driver connects the gateway container to the app network (T0.7).
 */
describe("gateway network attach", () => {
  const docker = new Docker();
  const provider = new DockerRuntimeProvider({ gatewayContainerName: GATEWAY_NAME });
  const appIds: string[] = [];
  let gatewayId: string | undefined;

  afterAll(async () => {
    for (const id of appIds) {
      try {
        await provider.remove(id, { deleteVolume: true });
      } catch {
        // ignore
      }
    }
    if (gatewayId) {
      try {
        const c = docker.getContainer(gatewayId);
        await c.stop({ t: 1 }).catch(() => undefined);
        await c.remove({ force: true });
      } catch {
        // ignore
      }
    }
  }, 120_000);

  it("connects the gateway container to the app network on deploy", async () => {
    await new Promise<void>((resolve, reject) => {
      docker.pull("alpine:3.20", (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }
        docker.modem.followProgress(stream, (followErr: Error | null) => {
          if (followErr) reject(followErr);
          else resolve();
        });
      });
    });

    // Minimal pause container as stand-in for scad-gateway
    const created = await docker.createContainer({
      name: GATEWAY_NAME,
      Image: "alpine:3.20",
      Cmd: ["sleep", "3600"],
      HostConfig: { AutoRemove: false },
    });
    gatewayId = created.id;
    await created.start();

    const imageRef = await ensureHttpEchoImage();
    const appId = newId();
    appIds.push(appId);

    const ref = await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });

    const net = await docker.getNetwork(networkName(appId)).inspect();
    const attached = Object.values(net.Containers ?? {}).some((c) =>
      c.Name.replace(/^\//, "").includes(GATEWAY_NAME),
    );
    expect(attached).toBe(true);

    const addr = await provider.address(ref);
    expect(addr.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(addr.port).toBe(8080);
  }, 180_000);
});
