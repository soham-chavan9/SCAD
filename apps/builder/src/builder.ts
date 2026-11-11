import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deploySpecFromManifest, makeError } from "@scad/shared";
import { DockerRuntimeProvider, RootImageError, VolumeQuotaExceededError } from "@scad/runtime-docker";
import { AutodetectError, prepareBuildContext, type BuildPlan } from "./autodetect.js";
import { buildFailedHint } from "./build-hint.js";
import { BUILD_TIMEOUT_MS, buildEnv, dockerBuild, type BuildResult } from "./docker-build.js";
import { FetchError, fetchNodeDependencies, fetchRubyGems, type FetchOptions } from "./fetch-deps.js";
import { ensureHugo, normaliseArch } from "./hugo.js";
import { SafeExtractError, safeExtractTarball } from "./safe-extract.js";

export { DEFAULT_CPU_SHARES, startToArgv } from "@scad/shared";

const execFileAsync = promisify(execFile);

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
  if (err instanceof RootImageError) {
    return makeError(
      "BUILD_FAILED",
      err.message,
      'Add a non-root "USER" line to the Dockerfile (for example "USER node" on node images, or create a user and switch to it), then republish.',
      {},
    );
  }
  return makeError(
    "BUILD_FAILED",
    err instanceof Error ? err.message : "Builder failed",
    "Inspect the build log, fix the app, and republish.",
    {},
  );
}

/** §8 envelope for a failed `docker build` (the control plane adds `log_tail`). */
export function buildFailureEnvelope(
  build: Extract<BuildResult, { ok: false }>,
  skippedInstallScripts: string[] = [],
): ReturnType<typeof makeError> {
  if (build.timedOut) {
    return makeError(
      "BUILD_FAILED",
      build.message,
      `Builds get ${BUILD_TIMEOUT_MS / 60_000} minutes. Make the build faster: vendor dependencies instead of compiling them in RUN steps, drop unneeded steps, and use a smaller base image, then republish.`,
      { timed_out: true },
    );
  }
  const hint = buildFailedHint(build.log.split("\n").slice(-200));
  if (skippedInstallScripts.length === 0) return makeError("BUILD_FAILED", build.message, hint, {});
  const list = skippedInstallScripts.slice(0, 10).join(", ");
  return makeError(
    "BUILD_FAILED",
    build.message,
    `${hint} Note: SCAD never runs package install scripts, and these packages have one: ${list}. If the error mentions one of them, switch to a version that ships prebuilt binaries or a pure-JavaScript alternative, then republish.`,
    { skipped_install_scripts: skippedInstallScripts.slice(0, 50) },
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
  /** Trusted dependency fetch settings (T3.2). */
  fetchDeps?: FetchOptions;
};

export class Builder {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #runtime: DockerRuntimeProvider;
  readonly #fetch: typeof fetch;
  readonly #fetchDeps: FetchOptions;

  constructor(opts: BuilderOptions) {
    this.#baseUrl = opts.controlPlaneUrl.replace(/\/$/, "");
    this.#token = opts.internalToken;
    this.#runtime = opts.runtime ?? new DockerRuntimeProvider();
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#fetchDeps = opts.fetchDeps ?? {};
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

      // No Dockerfile: write one from a built-in template (T2.4). Port comes
      // from the stored manifest; env is not needed (and not fetched) yet.
      const { port: templatePort } = deploySpecFromManifest({
        appId: job.appId,
        imageRef: "",
        manifest: job.manifest,
        runtimeEnv: {},
      });
      let plan: BuildPlan;
      try {
        plan = await prepareBuildContext(work, templatePort, { hugoBinary: () => this.#hugoBinary() });
        if (plan.kind !== "dockerfile") {
          await this.#log(
            job.releaseId,
            `no Dockerfile: using SCAD's built-in ${plan.label ? `${plan.label} site` : plan.kind} template`,
          );
        }
      } catch (err) {
        if (err instanceof AutodetectError) {
          await this.#log(job.releaseId, `auto-detect failed: ${err.message}`);
          await this.#fail(job.releaseId, err.envelope);
          return;
        }
        throw err;
      }

      // T3.2 trusted fetch: registry-only, scripts off, before the offline build.
      let skippedInstallScripts: string[] = [];
      if (plan.fetch) {
        await this.#log(job.releaseId, `downloading dependencies (${plan.fetch === "npm" ? "npm registry" : "rubygems.org"} only, install scripts off)`);
        try {
          const lines: string[] = [];
          const opts = { ...this.#fetchDeps, log: (l: string) => lines.push(l) };
          const fetched = plan.fetch === "npm" ? await fetchNodeDependencies(work, opts) : await fetchRubyGems(work, opts);
          skippedInstallScripts = fetched.skippedInstallScripts;
          await this.#log(job.releaseId, [...lines, fetched.log.trim()].filter(Boolean).join("\n"));
          if (skippedInstallScripts.length > 0) {
            await this.#log(job.releaseId, `install scripts skipped for: ${skippedInstallScripts.join(", ")}`);
          }
        } catch (err) {
          if (err instanceof FetchError) {
            if (err.log) await this.#log(job.releaseId, err.log);
            await this.#log(job.releaseId, `dependency download failed: ${err.message}`);
            await this.#fail(job.releaseId, err.envelope);
            return;
          }
          throw err;
        }
      }

      const imageRef = `scad-apps/${job.appId}:v${job.version}`;
      const build = await dockerBuild({ contextDir: work, imageRef });
      await this.#log(job.releaseId, build.log);

      if (!build.ok) {
        await this.#fail(job.releaseId, buildFailureEnvelope(build, skippedInstallScripts));
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
        // Same hardening and internal app network as the deploy (T2.2): the
        // new image never runs with internet, host access, or a published port.
        await this.#runtime.smokeCheck(spec, { timeoutMs: 30_000 });
      } catch (err) {
        if (err instanceof RootImageError) throw err; // BUILD_FAILED with its own hint
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

  /** Verified Hugo binary for the Docker daemon's architecture (T3.2). */
  async #hugoBinary(): Promise<string> {
    const { stdout } = await execFileAsync("docker", ["version", "-f", "{{.Server.Arch}}"], { env: buildEnv(process.env) });
    return ensureHugo(normaliseArch(String(stdout)));
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
