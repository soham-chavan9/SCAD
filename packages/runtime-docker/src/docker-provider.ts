import type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  Reachable,
  RuntimeProvider,
} from "@scad/runtime-conformance";
import type { Readable } from "node:stream";
import Docker from "dockerode";
import { linesFromDockerLogs } from "./logs.js";
import {
  appLabels,
  assertAppId,
  containerName,
  LABEL_PORT,
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
};

const DEFAULT_GATEWAY_CONTAINER = "scad-gateway";

export class DockerRuntimeProvider implements RuntimeProvider {
  readonly #docker: Docker;
  readonly #gatewayContainerName: string | null;

  constructor(options: DockerRuntimeOptions = {}) {
    this.#docker = new Docker(options.docker);
    this.#gatewayContainerName =
      options.gatewayContainerName === undefined
        ? DEFAULT_GATEWAY_CONTAINER
        : options.gatewayContainerName;
  }

  async ensureApp(appId: string, _diskGb: number): Promise<void> {
    assertAppId(appId);
    await this.#ensureNetwork(appId);
    await this.#ensureVolume(appId);
  }

  async deploy(spec: DeploySpec): Promise<MachineRef> {
    assertAppId(spec.appId);
    await this.ensureApp(spec.appId, spec.limits.diskGb);
    await this.#assertNonRootImage(spec.imageRef);
    await this.#removeExistingContainer(spec.appId);

    const net = networkName(spec.appId);
    const vol = volumeName(spec.appId);
    const name = containerName(spec.appId);
    const labels = {
      ...appLabels(spec.appId),
      [LABEL_PORT]: String(spec.port),
    };

    const createOpts: Docker.ContainerCreateOptions = {
      name,
      Image: spec.imageRef,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      ExposedPorts: { [`${spec.port}/tcp`]: {} },
      // Override command when manifest provides `start`
      ...(spec.start !== undefined
        ? { Entrypoint: ["/bin/sh", "-c"], Cmd: [spec.start] }
        : {}),
      HostConfig: {
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: spec.limits.memoryMb * 1024 * 1024,
        CpuShares: spec.limits.cpuShares,
        PidsLimit: spec.limits.pids,
        NetworkMode: net,
        Binds: [`${vol}:/data:rw`],
        Tmpfs: {
          "/tmp": "rw,noexec,nosuid,size=64m",
        },
      },
    };

    const container = await this.#docker.createContainer(createOpts);
    await container.start();
    await this.#connectGateway(spec.appId);
    return { appId: spec.appId, providerId: container.id };
  }

  async start(m: MachineRef): Promise<void> {
    const container = this.#docker.getContainer(m.providerId);
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
    const portLabel = info.Config.Labels?.[LABEL_PORT];
    const port = portLabel ? Number.parseInt(portLabel, 10) : 8080;
    if (!Number.isFinite(port)) {
      throw new Error(`invalid scad.port label on ${m.providerId}`);
    }
    return { host: ip, port };
  }

  async *logs(
    m: MachineRef,
    opts: { follow: boolean; tail?: number },
  ): AsyncIterable<string> {
    const container = this.#docker.getContainer(m.providerId);
    const tail = opts.tail ?? 100;
    if (opts.follow) {
      const stream = (await container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        tail,
      })) as unknown as Readable;
      yield* linesFromDockerLogs(stream);
      return;
    }
    const buf = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
      tail,
    });
    yield* linesFromDockerLogs(buf);
  }

  async remove(appId: string, opts: { deleteVolume: boolean }): Promise<void> {
    assertAppId(appId);
    await this.#removeExistingContainer(appId);
    await this.#disconnectGateway(appId);

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

  async #ensureVolume(appId: string): Promise<void> {
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
        Labels: appLabels(appId),
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
    try {
      const container = this.#docker.getContainer(name);
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop({ t: 2 }).catch(() => undefined);
      }
      await container.remove({ force: true });
    } catch (err) {
      if (isDockerError(err) && err.statusCode === 404) {
        return;
      }
      throw err;
    }
  }

  async #connectGateway(appId: string): Promise<void> {
    const gateway = this.#gatewayContainerName;
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
    const gateway = this.#gatewayContainerName;
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
      throw new Error(
        `image ${imageRef} must set a non-root USER (INV6); got ${user === "" ? "(empty/root)" : user}`,
      );
    }
  }

}

type DockerError = { statusCode?: number; message?: string };

function isDockerError(err: unknown): err is DockerError {
  return typeof err === "object" && err !== null;
}
