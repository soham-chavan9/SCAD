import type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  Reachable,
  RuntimeProvider,
} from "@scad/runtime-conformance";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import Docker from "dockerode";
import { chooseOciRuntime, hardenedHostConfig } from "./hardening.js";
import { linesFromDockerLogs } from "./logs.js";
import {
  appLabels,
  assertAppId,
  containerName,
  LABEL_PORT,
  LABEL_ROLE,
  networkName,
  volumeName,
} from "./names.js";

export type DockerRuntimeOptions = {
  /** dockerode / Docker modem options. Defaults to local socket. */
  docker?: Docker.DockerOptions;
  /**
   * Gateway container name to attach to each app network on deploy (T0.7).
   * Defaults to `scad-gateway`. Set `null` to disable attachment (unit tests).
   */
  gatewayContainerName?: string | null;
  /**
   * Egress proxy container attached to each app network (T2.1). Apps get
   * `HTTP(S)_PROXY=http://{name}:3128`. Defaults to `scad-egress`; `null`
   * disables (apps then have no way out at all).
   */
  egressProxyContainerName?: string | null;
  /**
   * Directory the proxy mounts read-only; the driver writes one
   * `{appId}.json` policy per app (`{appId, subnet, allow}`). Defaults to
   * `$SCAD_EGRESS_POLICY_DIR` or `~/.scad/egress-policy`.
   */
  egressPolicyDir?: string;
  /** Bytes per `diskGb` unit. Default 1 GiB; tests shrink it to keep fills small. */
  bytesPerDiskGb?: number;
  /** Only log lines newer than this are served (AGENTS §14: 7-day log retention). */
  logRetentionMs?: number;
  /**
   * OCI runtime policy (INV6): `auto` uses gVisor `runsc` when Docker has it,
   * `runsc` requires it, `runc` never uses it. Defaults to `$SCAD_OCI_RUNTIME`
   * or `auto`.
   */
  ociRuntime?: string;
};

/** AGENTS §14 default log retention. */
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Docker keeps only a small rotating buffer (2 x 1 MB) per container. The
 * control plane copies output into its own store, where retention is a real
 * 7-day delete; the `since` window below only bounds what that copy reads.
 */
export const APP_LOG_CONFIG = {
  Type: "json-file",
  Config: { "max-size": "1m", "max-file": "2" },
} as const;

const DEFAULT_GATEWAY_CONTAINER = "scad-gateway";
const DEFAULT_EGRESS_CONTAINER = "scad-egress";
const EGRESS_PROXY_PORT = 3128;

export function defaultEgressPolicyDir(): string {
  return process.env["SCAD_EGRESS_POLICY_DIR"] ?? join(homedir(), ".scad", "egress-policy");
}
const GIB = 1024 * 1024 * 1024;
/** Trusted helper image used to prepare and measure `/data` volumes. */
export const VOLUME_HELPER_IMAGE = "busybox:1.36";
const LABEL_DISK_BYTES = "scad.disk_bytes";

/**
 * Busybox loop: `$1` host, `$2` port, `$3` seconds. Prints
 * `SMOKE_STATUS=<code>` per HTTP answer; exits 0 on the first status below 500.
 */
const SMOKE_PROBE_SCRIPT = [
  'end=$(( $(date +%s) + $3 ))',
  'while [ "$(date +%s)" -lt "$end" ]; do',
  "  code=$(printf 'GET / HTTP/1.0\\r\\nHost: smoke\\r\\n\\r\\n' | nc -w 2 \"$1\" \"$2\" 2>/dev/null | head -n 1 | cut -d' ' -f2)",
  '  case "$code" in',
  '    [1-4][0-9][0-9]) echo "SMOKE_STATUS=$code"; exit 0 ;;',
  '    5[0-9][0-9]) echo "SMOKE_STATUS=$code" ;;',
  "  esac",
  "  usleep 250000 2>/dev/null || sleep 1",
  "done",
  "exit 1",
].join("\n");

/**
 * Docker local volumes have no size limit, so the quota is measured: a start
 * or deploy is refused while `/data` is over its limit, and
 * `enforceVolumeQuota` stops a running app that has grown past it.
 */
export class VolumeQuotaExceededError extends Error {
  readonly usedBytes: number;
  readonly limitBytes: number;

  constructor(usedBytes: number, limitBytes: number) {
    super(`/data uses ${usedBytes} bytes, over its ${limitBytes}-byte limit`);
    this.name = "VolumeQuotaExceededError";
    this.usedBytes = usedBytes;
    this.limitBytes = limitBytes;
  }
}

/** The image would run as root; SCAD refuses it before it starts (INV6). */
export class RootImageError extends Error {
  constructor(imageRef: string, user: string) {
    super(`image ${imageRef} must set a non-root USER (INV6); got ${user === "" ? "(empty/root)" : user}`);
    this.name = "RootImageError";
  }
}

export class DockerRuntimeProvider implements RuntimeProvider {
  readonly #docker: Docker;
  readonly #gatewayContainerName: string | null;
  readonly #egressContainerName: string | null;
  readonly #egressPolicyDir: string;
  readonly #bytesPerDiskGb: number;
  readonly #logRetentionMs: number;
  readonly #ociRuntimePolicy: string | undefined;
  #ociRuntimeChoice: Promise<string | undefined> | undefined;

  constructor(options: DockerRuntimeOptions = {}) {
    this.#docker = new Docker(options.docker);
    this.#bytesPerDiskGb = options.bytesPerDiskGb ?? GIB;
    this.#logRetentionMs = options.logRetentionMs ?? LOG_RETENTION_MS;
    this.#gatewayContainerName =
      options.gatewayContainerName === undefined
        ? DEFAULT_GATEWAY_CONTAINER
        : options.gatewayContainerName;
    this.#egressContainerName =
      options.egressProxyContainerName === undefined
        ? DEFAULT_EGRESS_CONTAINER
        : options.egressProxyContainerName;
    this.#egressPolicyDir = options.egressPolicyDir ?? defaultEgressPolicyDir();
    this.#ociRuntimePolicy = options.ociRuntime ?? process.env["SCAD_OCI_RUNTIME"];
  }

  /**
   * The OCI runtime apps run under: `runsc` (gVisor) or undefined for
   * Docker's default. Decided once per provider from what Docker reports.
   */
  ociRuntime(): Promise<string | undefined> {
    this.#ociRuntimeChoice ??= this.#docker.info().then((info: { Runtimes?: Record<string, unknown> }) =>
      chooseOciRuntime(Object.keys(info.Runtimes ?? {}), this.#ociRuntimePolicy),
    );
    // A failed lookup is not cached, so the next deploy asks Docker again.
    this.#ociRuntimeChoice.catch(() => {
      this.#ociRuntimeChoice = undefined;
    });
    return this.#ociRuntimeChoice;
  }

  async ensureApp(appId: string, diskGb: number): Promise<void> {
    assertAppId(appId);
    await this.#ensureNetwork(appId);
    await this.#ensureVolume(appId, diskGb);
  }

  async deploy(spec: DeploySpec): Promise<MachineRef> {
    assertAppId(spec.appId);
    await this.ensureApp(spec.appId, spec.limits.diskGb);
    await this.#assertNonRootImage(spec.imageRef);
    const limitBytes = spec.limits.diskGb * this.#bytesPerDiskGb;
    // Make /data writable for the image's non-root USER and check the quota
    // before the old release is torn down, so a refused deploy keeps serving.
    const usedBytes = await this.#prepareAndMeasureVolume(spec.appId);
    if (usedBytes > limitBytes) {
      throw new VolumeQuotaExceededError(usedBytes, limitBytes);
    }
    await this.#removeExistingContainer(spec.appId);

    const net = networkName(spec.appId);
    const vol = volumeName(spec.appId);
    const name = containerName(spec.appId);
    const labels = {
      ...appLabels(spec.appId),
      [LABEL_PORT]: String(spec.port),
      [LABEL_DISK_BYTES]: String(limitBytes),
    };

    const createOpts: Docker.ContainerCreateOptions = {
      name,
      Image: spec.imageRef,
      // Platform proxy vars come last so an app's env can't redirect them.
      Env: Object.entries({ ...spec.env, ...this.#proxyEnv() }).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      ExposedPorts: { [`${spec.port}/tcp`]: {} },
      // manifest.start as argv — never `/bin/sh -c` (no shell interpolation).
      ...(spec.start !== undefined && spec.start.length > 0
        ? { Entrypoint: spec.start, Cmd: [] }
        : {}),
      HostConfig: hardenedHostConfig({
        limits: spec.limits,
        networkMode: net,
        dataMount: { volume: vol },
        ociRuntime: await this.ociRuntime(),
        logConfig: { Type: APP_LOG_CONFIG.Type, Config: { ...APP_LOG_CONFIG.Config } },
      }),
    };

    let container;
    try {
      container = await this.#docker.createContainer(createOpts);
    } catch (err) {
      const message = isDockerError(err) ? (err.message ?? "") : String(err);
      if ((isDockerError(err) && err.statusCode === 409) || /already in use/i.test(message)) {
        await this.#removeExistingContainer(spec.appId);
        container = await this.#docker.createContainer(createOpts);
      } else {
        throw err;
      }
    }
    await this.#writeEgressPolicy(spec.appId, spec.egressAllow);
    await container.start();
    await this.#connectGateway(spec.appId);
    await this.#connectEgressProxy(spec.appId);
    return { appId: spec.appId, providerId: container.id };
  }

  /**
   * Builder smoke check (T2.2): run the new image once with exactly the
   * deploy's hardening on the app's own internal network (no internet, no
   * host, no egress proxy, a throwaway tmpfs for `/data`), and probe its port
   * from a helper container on that network. Resolves when the app answers
   * HTTP with a status below 500; throws otherwise. Never touches the running
   * release or its volume.
   */
  async smokeCheck(spec: DeploySpec, opts: { timeoutMs?: number } = {}): Promise<void> {
    assertAppId(spec.appId);
    const timeoutSec = Math.max(1, Math.ceil((opts.timeoutMs ?? 30_000) / 1000));
    await this.#ensureNetwork(spec.appId);
    await this.#assertNonRootImage(spec.imageRef);
    await this.#ensureHelperImage();
    const net = networkName(spec.appId);
    const labels = { ...appLabels(spec.appId), [LABEL_ROLE]: "smoke" };

    const app = await this.#docker.createContainer({
      Image: spec.imageRef,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      ExposedPorts: { [`${spec.port}/tcp`]: {} },
      ...(spec.start !== undefined && spec.start.length > 0 ? { Entrypoint: spec.start, Cmd: [] } : {}),
      HostConfig: hardenedHostConfig({
        limits: spec.limits,
        networkMode: net,
        dataMount: { tmpfsMb: 64 },
        ociRuntime: await this.ociRuntime(),
        logConfig: { Type: APP_LOG_CONFIG.Type, Config: { ...APP_LOG_CONFIG.Config } },
      }),
    });
    let probe: Docker.Container | undefined;
    try {
      await app.start();
      const info = await app.inspect();
      const ip = info.NetworkSettings.Networks?.[net]?.IPAddress;
      if (!ip || !/^[0-9.]+$/.test(ip)) throw new Error(`smoke container has no IP on ${net}`);
      probe = await this.#docker.createContainer({
        Image: VOLUME_HELPER_IMAGE,
        // Values are positional args to the fixed script, never interpolated.
        Cmd: ["sh", "-c", SMOKE_PROBE_SCRIPT, "smoke-probe", ip, String(spec.port), String(timeoutSec)],
        Labels: labels,
        HostConfig: {
          NetworkMode: net,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Memory: 32 * 1024 * 1024,
          PidsLimit: 32,
        },
      });
      await probe.start();
      await probe.wait();
      const out = String(await probe.logs({ stdout: true, stderr: false }));
      const codes = [...out.matchAll(/SMOKE_STATUS=(\d{3})/g)].map((m) => Number(m[1]));
      const last = codes.at(-1);
      if (last !== undefined && last < 500) return;
      throw new Error(
        `port ${spec.port} did not become ready${last !== undefined ? ` (last HTTP ${last})` : ""}`,
      );
    } finally {
      await probe?.remove({ force: true }).catch(() => undefined);
      await app.remove({ force: true }).catch(() => undefined);
    }
  }

  async start(m: MachineRef): Promise<void> {
    const container = this.#docker.getContainer(m.providerId);
    const usage = await this.volumeUsage(m.appId);
    if (usage.usedBytes > usage.limitBytes) {
      throw new VolumeQuotaExceededError(usage.usedBytes, usage.limitBytes);
    }
    try {
      await container.start();
    } catch (err) {
      if (isDockerError(err) && err.statusCode === 304) {
        return; // already started
      }
      throw err;
    }
  }

  async stop(m: MachineRef): Promise<void> {
    const container = this.#docker.getContainer(m.providerId);
    try {
      await container.stop({ t: 2 });
    } catch (err) {
      if (isDockerError(err) && (err.statusCode === 304 || err.statusCode === 404)) {
        return;
      }
      throw err;
    }
  }

  async status(m: MachineRef): Promise<MachineStatus> {
    try {
      const info = await this.#docker.getContainer(m.providerId).inspect();
      return info.State.Running ? "running" : "stopped";
    } catch (err) {
      if (isDockerError(err) && err.statusCode === 404) {
        return "missing";
      }
      throw err;
    }
  }

  async address(m: MachineRef): Promise<Reachable> {
    const info = await this.#docker.getContainer(m.providerId).inspect();
    if (!info.State.Running) {
      throw new Error(`machine ${m.providerId} is not running`);
    }
    const net = networkName(m.appId);
    const endpoint = info.NetworkSettings.Networks?.[net];
    const ip = endpoint?.IPAddress;
    if (!ip) {
      throw new Error(`no IP on network ${net} for container ${m.providerId}`);
    }
    const port = portFromLabel(info.Config.Labels?.[LABEL_PORT]);
    return { host: ip, port };
  }

  async *logs(
    m: MachineRef,
    opts: { follow: boolean; tail?: number },
  ): AsyncIterable<string> {
    const container = this.#docker.getContainer(m.providerId);
    const tail = opts.tail ?? 100;
    const since = Math.floor((Date.now() - this.#logRetentionMs) / 1000);
    if (opts.follow) {
      const stream = (await container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        tail,
        since,
      })) as unknown as Readable;
      yield* linesFromDockerLogs(stream);
      return;
    }
    const buf = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
      tail,
      since,
    });
    yield* linesFromDockerLogs(buf);
  }

  async remove(appId: string, opts: { deleteVolume: boolean }): Promise<void> {
    assertAppId(appId);
    await this.#removeExistingContainer(appId);
    await this.#disconnectGateway(appId);
    await this.#disconnectContainer(appId, this.#egressContainerName);
    await rm(this.#policyPath(appId), { force: true });

    const net = networkName(appId);
    try {
      await this.#docker.getNetwork(net).remove();
    } catch (err) {
      if (!(isDockerError(err) && err.statusCode === 404)) {
        throw err;
      }
    }

    if (opts.deleteVolume) {
      try {
        await this.#docker.getVolume(volumeName(appId)).remove();
      } catch (err) {
        if (!(isDockerError(err) && err.statusCode === 404)) {
          throw err;
        }
      }
    }
  }

  /** Bytes used by the app's `/data` volume and its limit (Docker-specific). */
  async volumeUsage(appId: string): Promise<{ usedBytes: number; limitBytes: number }> {
    assertAppId(appId);
    const usedBytes = await this.#measureVolume(appId, false);
    return { usedBytes, limitBytes: await this.#limitBytes(appId) };
  }

  /**
   * Stop the app if `/data` is over its limit. Call periodically (scheduler)
   * and after writes you suspect; returns what happened.
   */
  async enforceVolumeQuota(m: MachineRef): Promise<"ok" | "stopped"> {
    const usage = await this.volumeUsage(m.appId);
    if (usage.usedBytes <= usage.limitBytes) return "ok";
    await this.stop(m);
    return "stopped";
  }

  async #limitBytes(appId: string): Promise<number> {
    const fromLabel = (labels: Record<string, string> | undefined): number | null => {
      const n = Number.parseInt(labels?.[LABEL_DISK_BYTES] ?? "", 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    try {
      const info = await this.#docker.getContainer(containerName(appId)).inspect();
      const n = fromLabel(info.Config.Labels);
      if (n !== null) return n;
    } catch (err) {
      if (!(isDockerError(err) && err.statusCode === 404)) throw err;
    }
    const vol = await this.#docker.getVolume(volumeName(appId)).inspect();
    return fromLabel(vol.Labels ?? undefined) ?? this.#bytesPerDiskGb;
  }

  async #prepareAndMeasureVolume(appId: string): Promise<number> {
    return this.#measureVolume(appId, true);
  }

  /**
   * One-shot trusted helper (no network, read-only rootfs, only the caps it
   * needs). `prepare` makes the volume root sticky world-writable so any
   * non-root image USER can write (the volume is private to this app).
   */
  async #measureVolume(appId: string, prepare: boolean): Promise<number> {
    await this.#ensureHelperImage();
    const script = `${prepare ? "chmod 1777 /data && " : ""}du -sk /data`;
    const helper = await this.#docker.createContainer({
      Image: VOLUME_HELPER_IMAGE,
      Cmd: ["sh", "-c", script],
      Labels: { ...appLabels(appId), "scad.role": "volume-helper" },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: ["DAC_READ_SEARCH", "FOWNER"],
        SecurityOpt: ["no-new-privileges:true"],
        Binds: [`${volumeName(appId)}:/data:${prepare ? "rw" : "ro"}`],
      },
    });
    try {
      await helper.start();
      const result = (await helper.wait()) as { StatusCode: number };
      const logs = String(await helper.logs({ stdout: true, stderr: true }));
      if (result.StatusCode !== 0) {
        throw new Error(`volume helper failed for ${appId}`);
      }
      const m = /(\d+)\s+\/data/.exec(logs);
      if (!m?.[1]) throw new Error("volume helper printed no usage");
      return Number(m[1]) * 1024;
    } finally {
      await helper.remove({ force: true }).catch(() => undefined);
    }
  }

  async #ensureHelperImage(): Promise<void> {
    try {
      await this.#docker.getImage(VOLUME_HELPER_IMAGE).inspect();
      return;
    } catch (err) {
      if (!(isDockerError(err) && err.statusCode === 404)) throw err;
    }
    await new Promise<void>((resolve, reject) => {
      this.#docker.pull(VOLUME_HELPER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        this.#docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
      });
    });
  }

  async #ensureNetwork(appId: string): Promise<void> {
    const name = networkName(appId);
    try {
      await this.#docker.getNetwork(name).inspect();
      return;
    } catch (err) {
      if (!(isDockerError(err) && err.statusCode === 404)) {
        throw err;
      }
    }
    try {
      await this.#docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Internal: true,
        CheckDuplicate: true,
        Labels: appLabels(appId),
      });
    } catch (err) {
      // Concurrent ensureApp — treat already-exists as success
      if (isDockerError(err) && (err.statusCode === 409 || err.statusCode === 500)) {
        try {
          await this.#docker.getNetwork(name).inspect();
          return;
        } catch {
          throw err;
        }
      }
      throw err;
    }
  }

  async #ensureVolume(appId: string, diskGb: number): Promise<void> {
    const name = volumeName(appId);
    try {
      await this.#docker.getVolume(name).inspect();
      return;
    } catch (err) {
      if (!(isDockerError(err) && err.statusCode === 404)) {
        throw err;
      }
    }
    try {
      await this.#docker.createVolume({
        Name: name,
        Labels: { ...appLabels(appId), [LABEL_DISK_BYTES]: String(diskGb * this.#bytesPerDiskGb) },
      });
    } catch (err) {
      if (isDockerError(err) && err.statusCode === 409) {
        return;
      }
      throw err;
    }
  }

  async #removeExistingContainer(appId: string): Promise<void> {
    const name = containerName(appId);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const container = this.#docker.getContainer(name);
        const info = await container.inspect();
        if (info.State.Running) {
          await container.stop({ t: 2 }).catch(() => undefined);
        }
        await container.remove({ force: true });
        return;
      } catch (err) {
        if (isDockerError(err) && err.statusCode === 404) {
          return;
        }
        const message = isDockerError(err) ? (err.message ?? "") : String(err);
        // Concurrent stop/remove (e.g. redeploy while AutoRemove smoke) — wait and retry.
        if (
          (isDockerError(err) && err.statusCode === 409) ||
          /already in progress/i.test(message)
        ) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        throw err;
      }
    }
  }

  #proxyEnv(): Record<string, string> {
    if (!this.#egressContainerName) return {};
    const url = `http://${this.#egressContainerName}:${EGRESS_PROXY_PORT}`;
    return {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    };
  }

  #policyPath(appId: string): string {
    assertAppId(appId); // validated uuid: no path traversal (INV11)
    return join(this.#egressPolicyDir, `${appId}.json`);
  }

  /** Tell the egress proxy which subnet is this app and where it may go (T2.1). */
  async #writeEgressPolicy(appId: string, allow: string[]): Promise<void> {
    if (!this.#egressContainerName) return;
    const info = await this.#docker.getNetwork(networkName(appId)).inspect();
    const subnet = (info.IPAM?.Config ?? []).map((c) => c.Subnet).find((v): v is string => Boolean(v));
    if (!subnet) throw new Error(`network ${networkName(appId)} has no subnet`);
    await mkdir(this.#egressPolicyDir, { recursive: true });
    const file = this.#policyPath(appId);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ appId, subnet, allow })}\n`, { mode: 0o644 });
    await rename(tmp, file);
  }

  async #connectEgressProxy(appId: string): Promise<void> {
    await this.#connectContainer(appId, this.#egressContainerName);
  }

  async #connectGateway(appId: string): Promise<void> {
    await this.#connectContainer(appId, this.#gatewayContainerName);
  }

  async #connectContainer(appId: string, gateway: string | null): Promise<void> {
    if (!gateway) return;
    const net = networkName(appId);
    try {
      await this.#docker.getNetwork(net).connect({ Container: gateway });
    } catch (err) {
      // Already connected, or gateway not running yet (local unit tests).
      if (isDockerError(err) && (err.statusCode === 403 || err.statusCode === 404)) {
        return;
      }
      const message = isDockerError(err) ? (err.message ?? "") : "";
      if (/already (exists|connected)/i.test(message)) {
        return;
      }
      // Gateway missing in CI unit runs — soft-skip
      if (/No such container/i.test(message) || (isDockerError(err) && err.statusCode === 404)) {
        return;
      }
      throw err;
    }
  }

  async #disconnectGateway(appId: string): Promise<void> {
    await this.#disconnectContainer(appId, this.#gatewayContainerName);
  }

  async #disconnectContainer(appId: string, gateway: string | null): Promise<void> {
    if (!gateway) return;
    const net = networkName(appId);
    try {
      await this.#docker.getNetwork(net).disconnect({ Container: gateway, Force: true });
    } catch (err) {
      if (isDockerError(err) && (err.statusCode === 404 || err.statusCode === 500)) {
        return;
      }
      const message = isDockerError(err) ? (err.message ?? "") : "";
      if (/not (connected|found)|No such/i.test(message)) {
        return;
      }
      // ignore disconnect failures during teardown
    }
  }

  async #assertNonRootImage(imageRef: string): Promise<void> {
    let image: Docker.ImageInspectInfo;
    try {
      image = await this.#docker.getImage(imageRef).inspect();
    } catch (err) {
      if (isDockerError(err) && err.statusCode === 404) {
        throw new Error(`image not found: ${imageRef}`);
      }
      throw err;
    }
    const user = (image.Config.User ?? "").trim();
    if (!user || user === "0" || user === "root" || /^0:/.test(user) || /^root:/.test(user)) {
      throw new RootImageError(imageRef, user);
    }
  }

}

/** Port is the image label set at deploy. Missing label is an error, not port 8080. */
export function portFromLabel(label: string | undefined): number {
  if (label === undefined || label.trim() === "") {
    throw new Error("missing scad.port label");
  }
  const port = Number.parseInt(label, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("invalid scad.port label");
  }
  return port;
}

type DockerError = { statusCode?: number; message?: string };

function isDockerError(err: unknown): err is DockerError {
  return typeof err === "object" && err !== null;
}
