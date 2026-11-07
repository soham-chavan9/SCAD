import { applyManifestDefaults, type ManifestInput } from "./manifest.js";

/**
 * Docker relative CPU weight for one CPU. `1` is not one CPU; it starves the
 * container whenever anything else on the host is runnable.
 */
export const DEFAULT_CPU_SHARES = 1024;
/** AGENTS §11 default pids limit. */
export const DEFAULT_PIDS = 128;

/**
 * Split manifest.start into argv. Quotes are grouping, not shell syntax:
 * the result is passed as a Docker entrypoint array, never to `/bin/sh -c`.
 */
export function startToArgv(start: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;
  for (const match of start.trim().matchAll(re)) {
    let token = match[0];
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      token = token.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    }
    if (token.length > 0) out.push(token);
  }
  return out;
}

/** Same shape as the RuntimeProvider `DeploySpec` (AGENTS §4). */
export type DeploySpecShape = {
  appId: string;
  imageRef: string;
  port: number;
  start?: string[];
  env: Record<string, string>;
  egressAllow: string[];
  limits: { memoryMb: number; cpuShares: number; diskGb: number; pids: number };
};

/**
 * Build a deploy spec from a release manifest. `runtimeEnv` (stored env vars,
 * decrypted just in time) overrides `manifest.env` key by key.
 */
export function deploySpecFromManifest(opts: {
  appId: string;
  imageRef: string;
  manifest: unknown;
  runtimeEnv?: Record<string, string>;
}): DeploySpecShape {
  const manifest = applyManifestDefaults((opts.manifest ?? {}) as ManifestInput);
  const startArgv = manifest.start !== undefined ? startToArgv(manifest.start) : [];
  return {
    appId: opts.appId,
    imageRef: opts.imageRef,
    port: manifest.port,
    ...(startArgv.length > 0 ? { start: startArgv } : {}),
    env: { ...manifest.env, ...(opts.runtimeEnv ?? {}) },
    egressAllow: manifest.egress,
    limits: {
      memoryMb: manifest.resources.memory_mb,
      cpuShares: DEFAULT_CPU_SHARES,
      diskGb: manifest.resources.disk_gb,
      pids: DEFAULT_PIDS,
    },
  };
}
