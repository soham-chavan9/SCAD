import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BuildResult = {
  ok: true;
  imageRef: string;
  log: string;
} | {
  ok: false;
  log: string;
  message: string;
  /** The build ran past its time budget and was killed (T2.3). */
  timedOut?: boolean;
};

/** AGENTS §14: a build gets 10 minutes, then it is killed. */
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export type ExecFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Variables the docker CLI needs to find and talk to the daemon. Everything
 * else (MASTER_KEY, DATABASE_URL, INTERNAL_TOKEN, cloud creds, ...) is
 * dropped so no platform secret can leak into a build (INV8).
 */
const DOCKER_CLIENT_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_BUILDKIT",
] as const;

export function buildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DOCKER_CLIENT_ENV) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * `--network=none`: RUN steps get no network at all (INV8). Base images are
 * still pulled by the daemon. No `--build-arg`, `--secret`, or `--ssh` is
 * ever passed, so nothing from the platform reaches the build.
 */
export function buildArgs(opts: { contextDir: string; imageRef: string }): string[] {
  return [
    "build",
    "--network=none",
    "--progress=plain",
    "-t",
    opts.imageRef,
    opts.contextDir,
  ];
}

const defaultExec: ExecFn = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

export async function dockerBuild(opts: {
  contextDir: string;
  imageRef: string;
  /** Environment to filter for the docker CLI. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  /** Kill the build after this long. Defaults to {@link BUILD_TIMEOUT_MS}. */
  timeoutMs?: number;
}): Promise<BuildResult> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await exec("docker", buildArgs(opts), {
      env: buildEnv(opts.parentEnv ?? process.env),
      maxBuffer: 20 * 1024 * 1024,
      // The docker CLI cancels the BuildKit build when it gets SIGTERM.
      timeout: timeoutMs,
    });
    return { ok: true, imageRef: opts.imageRef, log: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const log = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? String(err)}`;
    if (e.killed === true) {
      return {
        ok: false,
        log,
        timedOut: true,
        message: `docker build timed out after ${formatDuration(timeoutMs)}`,
      };
    }
    return {
      ok: false,
      log,
      message: "docker build failed",
    };
  }
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  return `${Math.round(ms / 1000)} seconds`;
}

/** Platform secrets the builder process must never hold while it runs untrusted builds. */
export const PLATFORM_SECRET_ENV = [
  "MASTER_KEY",
  "JWT_PRIVATE_KEY",
  "GITHUB_CLIENT_SECRET",
  "INTERNAL_SECRET",
  "INTERNAL_TOKEN",
  "DATABASE_URL",
  "SMTP_URL",
] as const;

/**
 * Remove platform secrets from an env object in place. The builder reads
 * INTERNAL_TOKEN first, then calls this so neither child processes nor a
 * later code path can see it.
 */
export function scrubPlatformSecrets(env: NodeJS.ProcessEnv): void {
  for (const key of PLATFORM_SECRET_ENV) {
    delete env[key];
  }
}
