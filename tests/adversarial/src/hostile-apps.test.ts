import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DockerRuntimeProvider } from "@scad/runtime-docker";
import { newId } from "@scad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const docker = (...args: string[]) =>
  execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "../../../examples/adversarial");
const tag = (name: string) => `scad-test/adv-${name}:1`;

const limits = { memoryMb: 128, cpuShares: 1024, diskGb: 2, pids: 64 };

/** Build a hostile sample exactly as the builder would: offline. */
async function buildOffline(name: string): Promise<void> {
  await docker("build", "-q", "--network=none", "-t", tag(name), join(EXAMPLES, name));
}

/** Run the sample's probe inside its container, as the app's own user, and parse its JSON line. */
async function probe<T>(container: string, ...args: string[]): Promise<T> {
  const { stdout } = await docker("exec", container, "node", "/home/node/app/probe.js", ...args);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as T;
}

/**
 * Time an HTTP GET to the neighbour from a long-lived client container on its
 * network. Timed inside the client, so container start-up under CPU load is
 * not counted.
 */
async function timedGet(client: string, host: string): Promise<{ ok: boolean; ms: number }> {
  const script =
    "const t = Date.now(); fetch(process.argv[1]).then((r) => r.text())" +
    ".then((b) => console.log(JSON.stringify({ ok: b.includes('neighbour-ok'), ms: Date.now() - t })))" +
    ".catch(() => console.log(JSON.stringify({ ok: false, ms: Date.now() - t })))";
  const { stdout } = await docker("exec", client, "node", "-e", script, `http://${host}:8080/`);
  return JSON.parse(stdout.trim()) as { ok: boolean; ms: number };
}

const NEIGHBOUR_DOCKERFILE = [
  "FROM node:22-alpine",
  "USER node",
  `CMD ["node", "-e", "require('http').createServer((q, r) => r.end('neighbour-ok')).listen(8080)"]`,
  "",
].join("\n");

/**
 * T2.8: hostile sample apps from examples/adversarial, run with the real
 * Docker driver and the deploy hardening profile. Each test names the
 * invariant it defends (AGENTS §12). See tests/adversarial/README.md.
 */
describe("hostile apps are contained (T2.8, real Docker)", () => {
  // 1 "GB" of disk = 1 MiB here, so the disk test fills megabytes, not gigabytes.
  const provider = new DockerRuntimeProvider({
    gatewayContainerName: null,
    egressProxyContainerName: null,
    bytesPerDiskGb: 1024 * 1024,
  });
  const victimApp = newId();
  const snoopApp = newId();
  const escapeApp = newId();
  const cpuApp = newId();
  const diskApp = newId();
  const neighbourApp = newId();
  const marker = `scad-secret-${randomUUID()}`;
  const containers: Record<string, string> = {};
  let victimIp = "";
  let neighbour = { network: "", host: "" };
  const client = `scad-adv-client-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    for (const name of ["snoop", "escape", "cpu-hog", "disk-filler"]) await buildOffline(name);
    await execFileAsync(
      "sh",
      ["-c", `printf '%s' "$DF" | docker build -q --network=none -t ${tag("neighbour")} -`],
      { env: { ...process.env, DF: NEIGHBOUR_DOCKERFILE } },
    );
    const deploy = async (appId: string, image: string, env: Record<string, string> = {}) => {
      const m = await provider.deploy({
        appId,
        imageRef: tag(image),
        port: 8080,
        env,
        egressAllow: [],
        limits,
      });
      containers[appId] = m.providerId;
      return m;
    };
    // The victim holds a secret in its env and in its /data volume.
    const victim = await deploy(victimApp, "neighbour", { API_TOKEN: marker });
    await docker("exec", containers[victimApp]!, "sh", "-c", `echo ${marker} > /data/secret.txt`);
    victimIp = (await provider.address(victim)).host;
    const n = await deploy(neighbourApp, "neighbour");
    neighbour = { network: `scad-net-${neighbourApp}`, host: (await provider.address(n)).host };
    await docker(
      "run",
      "-d",
      "--name",
      client,
      "--network",
      neighbour.network,
      "--entrypoint",
      "sleep",
      tag("neighbour"),
      "600",
    );
    await deploy(snoopApp, "snoop");
    await deploy(escapeApp, "escape");
    await deploy(diskApp, "disk-filler");
  }, 300_000);

  afterAll(async () => {
    await docker("rm", "-f", client).catch(() => undefined);
    for (const id of [victimApp, snoopApp, escapeApp, cpuApp, diskApp, neighbourApp]) {
      await provider.remove(id, { deleteVolume: true }).catch(() => undefined);
    }
  }, 180_000);

  describe("reading another app's volume or env", () => {
    type Snoop = {
      secretHits: string[];
      dockerSockets: string[];
      processes: number;
      neighbourTcp: string;
    };
    let result: Snoop;
    beforeAll(async () => {
      result = await probe<Snoop>(containers[snoopApp]!, marker, victimIp);
    }, 60_000);

    it("INV1/INV7: a hostile app finds no trace of another app's secret env or /data files", () => {
      expect(result.secretHits).toEqual([]);
    });

    it("INV1: it sees only its own processes (separate pid namespace)", () => {
      expect(result.processes).toBeLessThan(10);
    });

    it("INV1: it cannot open a TCP connection to the other app", () => {
      expect(result.neighbourTcp).not.toBe("open");
    });

    it("INV1/INV8: no Docker or containerd socket is mounted into the app", () => {
      expect(result.dockerSockets).toEqual([]);
    });

    it("control: the victim really holds the secret (so the probe would have found it)", async () => {
      const { stdout } = await docker(
        "exec",
        containers[victimApp]!,
        "sh",
        "-c",
        "cat /data/secret.txt; echo $API_TOKEN",
      );
      expect(stdout.split(marker).length - 1).toBe(2);
    });
  });

  describe("escaping the sandbox via privileged syscalls", () => {
    type Escape = {
      attempts: Record<string, string>;
      uid: number;
      capEff: string;
      capPrm: string;
      noNewPrivs: string;
      seccomp: string;
    };
    let result: Escape;
    beforeAll(async () => {
      result = await probe<Escape>(containers[escapeApp]!);
    }, 60_000);

    it.each([
      "setuid-root",
      "setgid-root",
      "write-rootfs",
      "chown-to-root",
      "mount-tmpfs",
      "mknod-device",
      "chroot",
      "user-namespace",
      "raw-socket",
      "icmp-to-internet",
      "sysrq-trigger",
      "kernel-param",
      "load-module",
      "exec-from-tmp",
    ])("INV6: %s is blocked", (attempt) => {
      expect(result.attempts[attempt], `${attempt}: ${result.attempts[attempt]}`).toMatch(
        /^blocked/,
      );
    });

    it("INV6: runs as non-root with no capabilities, no-new-privileges, and a seccomp filter", () => {
      expect(result.uid).not.toBe(0);
      expect(result.capEff).toBe("0000000000000000");
      expect(result.capPrm).toBe("0000000000000000");
      expect(result.noNewPrivs).toBe("1");
      expect(result.seccomp).toBe("2");
    });
  });

  it("INV6: a CPU hog cannot starve its neighbour", async () => {
    const before = await timedGet(client, neighbour.host);
    expect(before.ok).toBe(true);
    const m = await provider.deploy({
      appId: cpuApp,
      imageRef: tag("cpu-hog"),
      port: 8080,
      env: {},
      egressAllow: [],
      limits,
    });
    containers[cpuApp] = m.providerId;
    await new Promise((r) => setTimeout(r, 3000)); // let it saturate
    const { stdout } = await docker(
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}",
      m.providerId,
    );
    expect(Number.parseFloat(stdout)).toBeGreaterThan(50); // it really is burning CPU
    for (let i = 0; i < 5; i++) {
      const during = await timedGet(client, neighbour.host);
      expect(during.ok).toBe(true);
      expect(during.ms, `request ${i} took ${during.ms} ms`).toBeLessThan(1000);
    }
    await provider.remove(cpuApp, { deleteVolume: true });
  }, 120_000);

  describe("filling the disk", () => {
    type Fill = { mib: number; stopped: string };
    let result: { rootfs: Fill; tmp: Fill; data: Fill };
    beforeAll(async () => {
      // diskGb 2 = 2 MiB here; write 8 MiB to /data.
      result = await probe(containers[diskApp]!, "8");
    }, 120_000);

    it("INV6: the root filesystem is read-only", () => {
      expect(result.rootfs).toEqual({ mib: 0, stopped: "EROFS" });
    });

    it("INV6: /tmp is a size-capped tmpfs (64 MiB)", () => {
      expect(result.tmp.stopped).toBe("ENOSPC");
      expect(result.tmp.mib).toBeLessThanOrEqual(64);
    });

    it("INV6: a /data volume over its limit is stopped and cannot start again (measured quota)", async () => {
      expect(result.data.mib).toBe(8); // Docker local volumes have no hard quota (docs/data-volume.md)
      const ref = { appId: diskApp, providerId: containers[diskApp]! };
      expect(await provider.enforceVolumeQuota(ref)).toBe("stopped");
      expect(await provider.status(ref)).toBe("stopped");
      await expect(provider.start(ref)).rejects.toMatchObject({ name: "VolumeQuotaExceededError" });
    }, 60_000);

    it("INV6: container logs are a small rotating buffer, so a log flood can't fill the host", async () => {
      const { stdout } = await docker(
        "inspect",
        "-f",
        "{{json .HostConfig.LogConfig}}",
        containers[diskApp]!,
      );
      const log = JSON.parse(stdout) as { Type: string; Config: Record<string, string> };
      expect(log.Type).toBe("json-file");
      expect(log.Config["max-size"]).toBeTruthy();
      expect(log.Config["max-file"]).toBeTruthy();
    });
  });
});
