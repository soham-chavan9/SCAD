import { createServer } from "node:net";
import { newId } from "@scad/shared";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { containerName, networkName } from "./names.js";
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

async function probeFromAppNet(
  docker: Docker,
  appId: string,
  cmd: string[],
): Promise<{ status: number; logs: string }> {
  await pullImage(docker, "busybox:1.36");
  const probe = await docker.createContainer({
    Image: "busybox:1.36",
    Cmd: cmd,
    HostConfig: {
      NetworkMode: networkName(appId),
      AutoRemove: false,
    },
  });
  try {
    await probe.start();
    const result = await probe.wait();
    const logsBuf = await probe.logs({ stdout: true, stderr: true });
    return { status: result.StatusCode, logs: String(logsBuf) };
  } finally {
    await probe.remove({ force: true }).catch(() => undefined);
  }
}

/** Best-effort host gateway IP as seen from a Docker bridge (INV1). */
async function bridgeGatewayIp(docker: Docker): Promise<string | null> {
  try {
    const nets = await docker.listNetworks();
    const bridge = nets.find((n) => n.Name === "bridge");
    if (!bridge) return null;
    const info = await docker.getNetwork(bridge.Id).inspect();
    const gw = info.IPAM?.Config?.[0]?.Gateway;
    return typeof gw === "string" && gw.length > 0 ? gw : null;
  } catch {
    return null;
  }
}

/**
 * INV1 / INV2 / INV6 — real Docker probes (not mocks).
 */
describe("app network isolation + hardened HostConfig", () => {
  const docker = new Docker();
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null });
  const appIds: string[] = [];
  let listenServer: ReturnType<typeof createServer> | undefined;
  let listenPort = 0;

  afterAll(async () => {
    if (listenServer) {
      await new Promise<void>((resolve) => listenServer!.close(() => resolve()));
    }
    for (const id of appIds) {
      try {
        await provider.remove(id, { deleteVolume: true });
      } catch {
        // ignore
      }
    }
  }, 180_000);

  it("INV1: from app network, TCP to CP port, Postgres, host gateway, metadata IP, other app all fail", async () => {
    // Local listener on host — stands in for control-plane port reachability.
    listenServer = createServer((socket) => socket.end("ok"));
    await new Promise<void>((resolve) => {
      listenServer!.listen(0, "0.0.0.0", () => resolve());
    });
    const addr = listenServer.address();
    if (!addr || typeof addr === "string") throw new Error("no listen port");
    listenPort = addr.port;

    const imageRef = await ensureHttpEchoImage();
    const appA = newId();
    const appB = newId();
    appIds.push(appA, appB);

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
    const gw = (await bridgeGatewayIp(docker)) ?? "172.17.0.1";

    const targets: { name: string; host: string; port: number }[] = [
      { name: "control-plane-port", host: gw, port: listenPort },
      { name: "postgres", host: gw, port: 5432 },
      { name: "host-gateway", host: gw, port: listenPort },
      { name: "metadata", host: "169.254.169.254", port: 80 },
      { name: "other-app", host: addrB.host, port: addrB.port },
    ];

    for (const t of targets) {
      // busybox nc: exit non-zero on connect failure / timeout
      const probe = await probeFromAppNet(docker, appA, [
        "nc",
        "-z",
        "-w",
        "2",
        t.host,
        String(t.port),
      ]);
      expect(probe.status, `INV1 ${t.name} should fail; logs=${probe.logs}`).not.toBe(0);
    }
  }, 240_000);

  it("INV2: no outbound internet and no external DNS from app network", async () => {
    const imageRef = await ensureHttpEchoImage();
    const appId = newId();
    appIds.push(appId);
    await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });

    const http = await probeFromAppNet(docker, appId, [
      "wget",
      "-T",
      "3",
      "-q",
      "-O",
      "-",
      "http://1.1.1.1/",
    ]);
    expect(http.status, `INV2 internet; logs=${http.logs}`).not.toBe(0);

    const dns = await probeFromAppNet(docker, appId, [
      "nslookup",
      "example.com",
    ]);
    // busybox nslookup returns non-zero when DNS unreachable / NXDOMAIN via no resolver
    expect(dns.status, `INV2 DNS; logs=${dns.logs}`).not.toBe(0);
  }, 180_000);

  it("INV6: HostConfig is non-root, ReadonlyRootfs, CapDrop ALL, no-new-privileges, limits, no published ports, no docker.sock", async () => {
    const imageRef = await ensureHttpEchoImage();
    const appId = newId();
    appIds.push(appId);
    const machine = await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      start: ["/bin/sh", "-c", "node server.js"],
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });

    const info = await docker.getContainer(machine.providerId).inspect();
    const hc = info.HostConfig;
    const cfg = info.Config;

    expect(cfg.User && cfg.User !== "0" && cfg.User !== "root").toBe(true);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop?.map((c) => c.toUpperCase())).toContain("ALL");
    expect(hc.SecurityOpt?.some((s) => /no-new-privileges/i.test(s))).toBe(true);
    expect(hc.Memory).toBe(128 * 1024 * 1024);
    expect(hc.CpuShares).toBe(512);
    expect(hc.PidsLimit).toBe(64);

    // No published host ports
    const ports = info.NetworkSettings.Ports ?? {};
    for (const bindings of Object.values(ports)) {
      expect(bindings === null || bindings === undefined || bindings.length === 0).toBe(true);
    }

    // No docker.sock bind
    const binds = hc.Binds ?? [];
    expect(binds.some((b) => b.includes("docker.sock"))).toBe(false);
    const mounts = info.Mounts ?? [];
    expect(mounts.some((m) => (m.Source ?? "").includes("docker.sock"))).toBe(false);

    // start passed as argv array on Config.Cmd
    expect(Array.isArray(cfg.Cmd)).toBe(true);
    expect(cfg.Cmd).toEqual(["/bin/sh", "-c", "node server.js"]);
    expect(info.Name.replace(/^\//, "")).toBe(containerName(appId));
  }, 180_000);

  it("deployed sample container is not reachable from another app network", async () => {
    const imageRef = await ensureHttpEchoImage();
    const appA = newId();
    const appB = newId();
    appIds.push(appA, appB);

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
    const probe = await probeFromAppNet(docker, appA, [
      "wget",
      "-T",
      "3",
      "-q",
      "-O",
      "-",
      `http://${addrB.host}:${addrB.port}/`,
    ]);
    expect(probe.status, `wget logs: ${probe.logs}`).not.toBe(0);
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
