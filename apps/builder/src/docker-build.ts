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
};

export type ExecFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; maxBuffer: number },
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
}): Promise<BuildResult> {
  const exec = opts.exec ?? defaultExec;
  try {
    const { stdout, stderr } = await exec("docker", buildArgs(opts), {
      env: buildEnv(opts.parentEnv ?? process.env),
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, imageRef: opts.imageRef, log: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const log = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? String(err)}`;
    return {
      ok: false,
      log,
      message: "docker build failed",
    };
  }
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
