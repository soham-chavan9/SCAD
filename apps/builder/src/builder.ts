import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyManifestDefaults, makeError, type ManifestInput } from "@scad/shared";
import { DockerRuntimeProvider } from "@scad/runtime-docker";
import { dockerBuild } from "./docker-build.js";
import { extractPublishTarball, SafeExtractError } from "./safe-extract.js";
import { smokeCheckHttp } from "./smoke.js";
import { manifestStartToArgv } from "./start-argv.js";

export type ClaimedJob = {
  releaseId: string;
  appId: string;
  version: number;
  manifest: unknown;
  tarballPath: string;
};

export type BuilderOptions = {
  controlPlaneUrl: string;
  internalToken: string;
  runtime?: DockerRuntimeProvider;
  fetchImpl?: typeof fetch;
};

export class Builder {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #runtime: DockerRuntimeProvider;
  readonly #fetch: typeof fetch;

  constructor(opts: BuilderOptions) {
    this.#baseUrl = opts.controlPlaneUrl.replace(/\/$/, "");
    this.#token = opts.internalToken;
    this.#runtime = opts.runtime ?? new DockerRuntimeProvider();
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async claim(): Promise<ClaimedJob | null> {
    const res = await this.#fetch(`${this.#baseUrl}/internal/builds/claim`, {
      method: "POST",
      headers: { "x-scad-internal-token": this.#token },
    });
    if (!res.ok) {
      throw new Error(`claim failed: ${res.status}`);
    }
    const body = (await res.json()) as { job: ClaimedJob | null };
    return body.job;
  }

  async processNext(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    await this.processJob(job);
    return true;
  }

  async processJob(job: ClaimedJob): Promise<void> {
    let work: string | undefined;
    try {
      await this.#log(job.releaseId, `claimed release ${job.releaseId} v${job.version}`);
      work = await extractPublishTarball(job.tarballPath);

      const imageRef = `scad-apps/${job.appId}:v${job.version}`;
      const build = await dockerBuild({ contextDir: work, imageRef });
      await this.#log(job.releaseId, build.log);

      if (!build.ok) {
        await this.#fail(
          job.releaseId,
          makeError(
            "BUILD_FAILED",
            build.message,
            "Fix the Dockerfile (or build context) and republish.",
            {},
          ),
        );
        return;
      }

      const manifest = applyManifestDefaults(
        (job.manifest ?? {}) as ManifestInput,
      );
      const port = manifest.port;

      try {
        await this.#log(job.releaseId, `smoke-checking port ${port}`);
        await smokeCheckHttp({ imageRef, port, timeoutMs: 30_000 });
      } catch (err) {
        await this.#log(job.releaseId, `smoke failed: ${String(err)}`);
        await this.#fail(
          job.releaseId,
          makeError(
            "PORT_NOT_LISTENING",
            `App did not accept HTTP on port ${port} within 30s`,
            `Ensure the process listens on 0.0.0.0:${port} and matches scad.json port.`,
            {},
          ),
        );
        return;
      }

      await this.#runtime.ensureApp(job.appId, manifest.resources.disk_gb);
      // start is always a string[] argv for Docker — never host-shell interpolated.
      const startArgv =
        manifest.start !== undefined ? manifestStartToArgv(manifest.start) : undefined;
      const machine = await this.#runtime.deploy({
        appId: job.appId,
        imageRef,
        port,
        ...(startArgv !== undefined ? { start: startArgv } : {}),
        env: manifest.env,
        egressAllow: manifest.egress,
        limits: {
          memoryMb: manifest.resources.memory_mb,
          cpuShares: 1,
          diskGb: manifest.resources.disk_gb,
          pids: 128,
        },
      });

      await this.#completeOk(job.releaseId, imageRef, machine.providerId);
      await this.#log(job.releaseId, `deployed ${machine.providerId}`);
    } catch (err) {
      await this.#log(job.releaseId, `builder error: ${String(err)}`);
      if (err instanceof SafeExtractError) {
        await this.#fail(job.releaseId, err.envelope);
        return;
      }
      await this.#fail(
        job.releaseId,
        makeError(
          "BUILD_FAILED",
          err instanceof Error ? err.message : "Builder failed",
          "Inspect the build log, fix the app, and republish.",
          {},
        ),
      );
    } finally {
      if (work) {
        await rm(work, { recursive: true, force: true });
      }
    }
  }

  async #log(releaseId: string, chunk: string): Promise<void> {
    await this.#fetch(`${this.#baseUrl}/internal/builds/${releaseId}/log`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scad-internal-token": this.#token,
      },
      body: JSON.stringify({ chunk }),
    });
  }

  async #completeOk(releaseId: string, imageRef: string, providerId: string): Promise<void> {
    const res = await this.#fetch(`${this.#baseUrl}/internal/builds/${releaseId}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scad-internal-token": this.#token,
      },
      body: JSON.stringify({ ok: true, imageRef, providerId }),
    });
    if (!res.ok) {
      throw new Error(`complete failed: ${res.status} ${await res.text()}`);
    }
  }

  async #fail(
    releaseId: string,
    error: ReturnType<typeof makeError>,
  ): Promise<void> {
    const res = await this.#fetch(`${this.#baseUrl}/internal/builds/${releaseId}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scad-internal-token": this.#token,
      },
      body: JSON.stringify({ ok: false, error }),
    });
    if (!res.ok) {
      throw new Error(`complete(failed) failed: ${res.status} ${await res.text()}`);
    }
  }
}

/** Extract helper kept for tests that write a fixture tarball. */
export async function writeTempFile(dir: string, name: string, data: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, data);
  return file;
}
