import { newId } from "@scad/shared";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { containerName, networkName } from "./names.js";
import { ensureHttpEchoImage } from "./test-image.js";

/**
 * T1.4 acceptance on real Docker: a stopped app answers its first HTTP request
 * within 10 s of `start`. Measured from inside the app network (the gateway's
 * vantage point), since apps are unreachable from the host.
 */
describe("wake latency (T1.4, real Docker)", () => {
  const docker = new Docker();
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null });
  const appId = newId();

  afterAll(async () => {
    await provider.remove(appId, { deleteVolume: true }).catch(() => undefined);
  });

  it("a stopped app answers HTTP within 10 s of start", async () => {
    const imageRef = await ensureHttpEchoImage(docker);
    await docker.getImage("busybox:1.36").inspect();

    const machine = await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 1024, diskGb: 1, pids: 64 },
    });
    await provider.stop(machine);
    expect(await provider.status(machine)).toBe("stopped");

    const t0 = Date.now();
    await provider.start(machine);
    const probe = await docker.createContainer({
      Image: "busybox:1.36",
      Cmd: [
        "sh",
        "-c",
        `i=0; until wget -q -T 1 -O /dev/null http://${containerName(appId)}:8080/; do i=$((i+1)); [ $i -gt 100 ] && exit 1; sleep 0.1; done`,
      ],
      HostConfig: { NetworkMode: networkName(appId) },
    });
    try {
      await probe.start();
      const result = await probe.wait();
      const elapsed = Date.now() - t0;
      expect(result.StatusCode).toBe(0);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await probe.remove({ force: true }).catch(() => undefined);
    }
  });
});
