import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { networkName } from "./names.js";

const execFileAsync = promisify(execFile);
const docker = (...args: string[]) => execFileAsync("docker", args);

const APP_IMAGE = "scad-test/reconnect-app:1";
const APP_DOCKERFILE = [
  "FROM node:22-alpine",
  "USER node",
  `CMD ["node", "-e", "require('http').createServer((q, r) => r.end('ok')).listen(8080)"]`,
  "",
].join("\n");

async function networksOf(container: string): Promise<string[]> {
  const { stdout } = await docker(
    "inspect",
    "-f",
    "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}",
    container,
  );
  return stdout.trim().split(/\s+/).filter(Boolean);
}

/**
 * T2.9: the gateway is attached to an app network at deploy. Recreating the
 * gateway container (`docker compose up -d gateway`, e.g. to rotate a secret)
 * leaves it on no app network; `reconnect` (called on wake and by the sweep)
 * puts it back, so apps don't stay unreachable until a redeploy.
 */
describe("reconnect platform containers (real Docker)", () => {
  const suffix = randomUUID().slice(0, 8);
  const gateway = `scad-test-gw-${suffix}`;
  const appId = randomUUID();
  const provider = new DockerRuntimeProvider({
    gatewayContainerName: gateway,
    egressProxyContainerName: null,
  });
  let providerId = "";

  const startGateway = () => docker("run", "-d", "--name", gateway, "busybox:1.36", "sleep", "600");

  beforeAll(async () => {
    await execFileAsync(
      "sh",
      ["-c", `printf '%s' "$DF" | docker build -q --network=none -t ${APP_IMAGE} -`],
      {
        env: { ...process.env, DF: APP_DOCKERFILE },
      },
    );
    await startGateway();
    const m = await provider.deploy({
      appId,
      imageRef: APP_IMAGE,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 64, cpuShares: 1024, diskGb: 1, pids: 32 },
    });
    providerId = m.providerId;
  }, 180_000);

  afterAll(async () => {
    await provider.remove(appId, { deleteVolume: true }).catch(() => undefined);
    await docker("rm", "-f", gateway).catch(() => undefined);
  }, 60_000);

  it("deploy attaches the gateway to the app network", async () => {
    expect(await networksOf(gateway)).toContain(networkName(appId));
  });

  it("a recreated gateway is on no app network until reconnect puts it back", async () => {
    await docker("rm", "-f", gateway);
    await startGateway();
    expect(await networksOf(gateway)).not.toContain(networkName(appId));
    await provider.reconnect({ appId, providerId });
    expect(await networksOf(gateway)).toContain(networkName(appId));
  }, 60_000);

  it("reconnect is idempotent", async () => {
    await provider.reconnect({ appId, providerId });
    await provider.reconnect({ appId, providerId });
    expect((await networksOf(gateway)).filter((n) => n === networkName(appId))).toHaveLength(1);
  });

  it("start reconnects too (wake after a gateway restart)", async () => {
    await provider.stop({ appId, providerId });
    await docker("rm", "-f", gateway);
    await startGateway();
    await provider.start({ appId, providerId });
    expect(await networksOf(gateway)).toContain(networkName(appId));
  }, 60_000);
});
