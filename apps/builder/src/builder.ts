import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploySpecFromManifest, makeError } from "@scad/shared";
import { DockerRuntimeProvider, VolumeQuotaExceededError } from "@scad/runtime-docker";
import { buildFailedHint } from "./build-hint.js";
import { dockerBuild } from "./docker-build.js";
import { SafeExtractError, safeExtractTarball } from "./safe-extract.js";
import { smokeCheckHttp } from "./smoke.js";

export { DEFAULT_CPU_SHARES, startToArgv } from "@scad/shared";

/** §8 envelope for a deploy that the runtime refused. */
export function deployErrorEnvelope(err: unknown): ReturnType<typeof makeError> {
  if (err instanceof VolumeQuotaExceededError) {
    return makeError(
      "LIMIT_EXCEEDED",
      `The app's /data volume uses ${Math.ceil(err.usedBytes / 1048576)} MiB, over its ${Math.floor(err.limitBytes / 1048576)} MiB limit`,
      'Delete data under /data, or raise "resources.disk_gb" in scad.json (cap 5), then republish. The previous release keeps its data.',
      { used_bytes: err.usedBytes, limit_bytes: err.limitBytes },
    );
  }
  return makeError(
    "BUILD_FAILED",
    err instanceof Error ? err.message : "Builder failed",
    "Inspect the build log, fix the app, and republish.",
    {},
  );
}

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
    const work = await mkdtemp(join(tmpdir(), "scad-build-"));
    try {
      await this.#log(job.releaseId, `claimed release ${job.releaseId} v${job.version}`);
      try {
        await safeExtractTarball({ tarballPath: job.tarballPath, destDir: work });
      } catch (err) {
        if (err instanceof SafeExtractError) {
          await this.#fail(job.releaseId, err.envelope);
          return;
        }
        throw err;
      }

      const imageRef = `scad-apps/${job.appId}:v${job.version}`;
      const build = await dockerBuild({ contextDir: work, imageRef });
      await this.#log(job.releaseId, build.log);

      if (!build.ok) {
        await this.#fail(
          job.releaseId,
          makeError(
            "BUILD_FAILED",
            build.message,
            buildFailedHint(build.log.split("\n").slice(-200)),
            {},
          ),
        );
        return;
      }

      // Stored env vars (incl. secrets) are fetched only now, after the build,
      // so they never reach `docker build` (INV7, INV8). Never logged.
      const runtimeEnv = await this.#runtimeEnv(job.releaseId);
      const spec = deploySpecFromManifest({
        appId: job.appId,
        imageRef,
        manifest: job.manifest,
        runtimeEnv,
      });
      const port = spec.port;

      try {
        await this.#log(job.releaseId, `smoke-checking port ${port}`);
        await smokeCheckHttp({
          imageRef,
          port,
          ...(spec.start ? { start: spec.start } : {}),
          env: spec.env,
          timeoutMs: 30_000,
        });
      } catch (err) {
        await this.#log(job.releaseId, `smoke failed: ${err instanceof Error ? err.message : "unknown error"}`);
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

      await this.#runtime.ensureApp(job.appId, spec.limits.diskGb);
      const machine = await this.#runtime.deploy(spec);

      await this.#completeOk(job.releaseId, imageRef, machine.providerId);
      await this.#log(job.releaseId, `deployed ${machine.providerId}`);
    } catch (err) {
      await this.#log(job.releaseId, `builder error: ${String(err)}`);
      await this.#fail(job.releaseId, deployErrorEnvelope(err));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Decrypted stored env for this release's app, fetched just in time (T1.6). */
  async #runtimeEnv(releaseId: string): Promise<Record<string, string>> {
    const res = await this.#fetch(`${this.#baseUrl}/internal/builds/${releaseId}/runtime-env`, {
      method: "POST",
      headers: { "x-scad-internal-token": this.#token },
    });
    if (!res.ok) {
      throw new Error(`runtime-env failed: ${res.status}`);
    }
    const body = (await res.json()) as { env: Record<string, string> };
    return body.env;
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
