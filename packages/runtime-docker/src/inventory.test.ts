import { newId } from "@scad/shared";
import { afterAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { ensureHttpEchoImage } from "./test-image.js";

/** T2.5 orphan reaper input: every app's container, network, and volume, found by label. */
describe("listApps (real Docker)", () => {
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null, egressProxyContainerName: null });
  const withContainer = newId();
  const networkOnly = newId();

  afterAll(async () => {
    for (const id of [withContainer, networkOnly]) {
      await provider.remove(id, { deleteVolume: true }).catch(() => undefined);
    }
  }, 120_000);

  it("reports each app's resources by kind", async () => {
    await provider.deploy({
      appId: withContainer,
      imageRef: await ensureHttpEchoImage(),
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });
    await provider.ensureApp(networkOnly, 1);

    const byId = new Map((await provider.listApps()).map((a) => [a.appId, a.resources]));
    expect(byId.get(withContainer)).toEqual(["container", "network", "volume"]);
    expect(byId.get(networkOnly)).toEqual(["network", "volume"]);

    await provider.remove(withContainer, { deleteVolume: true });
    expect((await provider.listApps()).some((a) => a.appId === withContainer)).toBe(false);
  }, 120_000);
});
