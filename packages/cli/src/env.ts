import type { EnvEntry, EnvUpdate } from "@scad/api-client";
import { client, type ClientOptions } from "./share.js";

/** Parse `KEY=value` arguments (split at the first `=`; values may be empty). */
export function parseAssignments(args: string[]): Record<string, string> {
  if (args.length === 0) throw new Error("Pass at least one KEY=value");
  const out: Record<string, string> = {};
  for (const arg of args) {
    const idx = arg.indexOf("=");
    if (idx <= 0) throw new Error(`Expected KEY=value, got "${arg.split("=")[0]}"`);
    out[arg.slice(0, idx)] = arg.slice(idx + 1);
  }
  return out;
}

/** Store env vars. With `secret`, every key in `vars` is write-only. */
export async function setEnv(
  opts: ClientOptions & { app: string; vars: Record<string, string>; secret?: boolean },
): Promise<EnvUpdate> {
  const secret = opts.secret ? Object.keys(opts.vars) : [];
  return (await client(opts)).setEnv(opts.app, opts.vars, secret);
}

export async function unsetEnv(opts: ClientOptions & { app: string; keys: string[] }): Promise<EnvUpdate> {
  const changes = Object.fromEntries(opts.keys.map((k) => [k, null]));
  return (await client(opts)).setEnv(opts.app, changes);
}

export async function listEnv(opts: ClientOptions & { app: string }): Promise<EnvEntry[]> {
  return (await (await client(opts)).listEnv(opts.app)).env;
}
