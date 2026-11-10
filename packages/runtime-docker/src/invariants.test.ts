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
        if (followErr) reject(followErr);
        else resolve();
      });
    });
  });
}

/** TCP connect probe from inside an app network; exit 0 = connected. */
async function tcpProbeFromAppNet(opts: {
  docker: Docker;
  appId: string;
  host: string;
  port: number;
  timeoutSec?: number;
}): Promise<{ ok: boolean; logs: string }> {
  const timeout = opts.timeoutSec ?? 3;
  await pullImage(opts.docker, "busybox:1.36");
  const probe = await opts.docker.createContainer({
    Image: "busybox:1.36",
    // nc -z returns 0 if the TCP handshake succeeds.
    Cmd: ["nc", "-z", "-w", String(timeout), opts.host, String(opts.port)],
    HostConfig: {
      NetworkMode: networkName(opts.appId),
      AutoRemove: false,
    },
  });
  try {
    await probe.start();
    const result = await probe.wait();
    const logsBuf = await probe.logs({ stdout: true, stderr: true });
    return { ok: result.StatusCode === 0, logs: String(logsBuf) };
  } finally {
    await probe.remove({ force: true }).catch(() => undefined);
  }
}

/** DNS lookup probe; exit 0 = resolved. */
async function dnsProbeFromAppNet(opts: {
  docker: Docker;
  appId: string;
  name: string;
}): Promise<{ ok: boolean; logs: string }> {
  await pullImage(opts.docker, "busybox:1.36");
  const probe = await opts.docker.createContainer({
    Image: "busybox:1.36",
    Cmd: ["nslookup", opts.name],
    HostConfig: {
      NetworkMode: networkName(opts.appId),
      AutoRemove: false,
    },
  });
  try {
    await probe.start();
    const result = await probe.wait();
    const logsBuf = await probe.logs({ stdout: true, stderr: true });
    return { ok: result.StatusCode === 0, logs: String(logsBuf) };
  } finally {
    await probe.remove({ force: true }).catch(() => undefined);
  }
}

function dockerBridgeGatewayIp(): string {
  // Default docker0 / bridge gateway on Linux; Docker Desktop often uses this too.
  return process.env["SCAD_HOST_GATEWAY_IP"] ?? "172.17.0.1";
}

describe("security invariants (real Docker)", () => {
  const docker = new Docker();
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null });
  const appIds: string[] = [];

  afterAll(async () => {
    for (const id of appIds) {
      try {
        await provider.remove(id, { deleteVolume: true });
      } catch {
        // ignore
      }
    }
  }, 180_000);

  it("INV1: app cannot TCP to control plane, Postgres, host gateway, metadata, or other app", async () => {
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
    const gw = dockerBridgeGatewayIp();

    const targets: { label: string; host: string; port: number }[] = [
      { label: "control-plane", host: gw, port: 4000 },
      { label: "postgres", host: gw, port: 5432 },
      { label: "host-gateway-ssh", host: gw, port: 22 },
      { label: "cloud-metadata", host: "169.254.169.254", port: 80 },
      { label: "other-app", host: addrB.host, port: addrB.port },
    ];

    for (const t of targets) {
      const result = await tcpProbeFromAppNet({
        docker,
        appId: appA,
        host: t.host,
        port: t.port,
      });
      expect(result.ok, `INV1 ${t.label} ${t.host}:${t.port} must fail; logs=${result.logs}`).toBe(
        false,
      );
    }
  }, 240_000);

  it("INV2: app has no outbound internet and no external DNS", async () => {
    const imageRef = await ensureHttpEchoImage();
    const appId = newId();
    appIds.push(appId);
    await provider.ensureApp(appId, 1);
    await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });

    const inet = await tcpProbeFromAppNet({
      docker,
      appId,
      host: "1.1.1.1",
      port: 443,
    });
    expect(inet.ok, `INV2 internet TCP must fail; logs=${inet.logs}`).toBe(false);

    const dns = await dnsProbeFromAppNet({
      docker,
      appId,
      name: "example.com",
    });
    expect(dns.ok, `INV2 external DNS must fail; logs=${dns.logs}`).toBe(false);
  }, 180_000);

  it("INV6: HostConfig is hardened (non-root, ro rootfs, caps, limits, no publish, no docker.sock)", async () => {
    const imageRef = await ensureHttpEchoImage();
    const appId = newId();
    appIds.push(appId);
    const limits = { memoryMb: 256, cpuShares: 512, diskGb: 1, pids: 64 };
    await provider.ensureApp(appId, 1);
    await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      env: {},
      egressAllow: [],
      limits,
    });

    const info = await docker.getContainer(containerName(appId)).inspect();
    const hc = info.HostConfig;
    const user = (info.Config.User ?? "").trim();

    expect(user, "non-root USER").not.toMatch(/^(?:|0|root|0:.*|root:.*)$/);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(expect.arrayContaining(["ALL"]));
    expect(hc.SecurityOpt ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/no-new-privileges/i)]),
    );
    expect(hc.Memory).toBe(limits.memoryMb * 1024 * 1024);
    expect(hc.CpuShares).toBe(limits.cpuShares);
    expect(hc.PidsLimit).toBe(limits.pids);
    expect(hc.MemorySwap, "no swap beyond the memory limit").toBe(limits.memoryMb * 1024 * 1024);
    expect(hc.CapAdd ?? []).toEqual([]);
    expect(hc.Privileged).toBe(false);

    const ports = info.NetworkSettings.Ports ?? {};
    for (const bindings of Object.values(ports)) {
      expect(bindings === null || bindings === undefined || bindings.length === 0).toBe(true);
    }
    expect(hc.PublishAllPorts ?? false).toBe(false);

    const binds = hc.Binds ?? [];
    expect(binds.some((b) => b.includes("docker.sock"))).toBe(false);
    const mounts = info.Mounts ?? [];
    expect(mounts.some((m) => (m.Source ?? "").includes("docker.sock"))).toBe(false);
  }, 180_000);

  it("manifest.start is applied as Entrypoint argv (no /bin/sh -c)", async () => {
    const imageRef = await ensureHttpEchoImage();
    const appId = newId();
    appIds.push(appId);
    await provider.ensureApp(appId, 1);
    // http-echo listens via its image CMD; override with equivalent argv.
    await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      start: ["node", "server.js"],
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    });

    const info = await docker.getContainer(containerName(appId)).inspect();
    const entry = info.Config.Entrypoint ?? [];
    const cmd = info.Config.Cmd;
    expect(entry).toEqual(["node", "server.js"]);
    // Empty Cmd after Entrypoint override (dockerode may normalize to null).
    expect(cmd === null || (Array.isArray(cmd) && cmd.length === 0)).toBe(true);
    expect(entry.join(" ")).not.toMatch(/\/bin\/sh/);
  }, 180_000);
});
