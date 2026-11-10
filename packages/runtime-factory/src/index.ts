import type { ManagedRuntime } from "@scad/runtime-conformance";
import { DockerRuntimeProvider } from "@scad/runtime-docker";

export const PACKAGE_NAME = "runtime-factory" as const;

/** Runtime drivers this build knows (D4). `fly` lands in M3 (T3.2). */
export const RUNTIME_KINDS = ["docker"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export class UnknownRuntimeError extends Error {
  constructor(kind: string) {
    super(`Unknown SCAD_RUNTIME "${kind}". Supported: ${RUNTIME_KINDS.join(", ")}.`);
    this.name = "UnknownRuntimeError";
  }
}

/**
 * Pick the runtime driver from `SCAD_RUNTIME` (default `docker`). This is the
 * only place services get a driver, so no service imports provider-specific
 * code (AGENTS §13); adding a driver means adding a case here.
 */
export function createRuntimeProvider(env: Record<string, string | undefined> = process.env): ManagedRuntime {
  const kind = env["SCAD_RUNTIME"]?.trim() || "docker";
  switch (kind) {
    case "docker":
      return new DockerRuntimeProvider();
    default:
      throw new UnknownRuntimeError(kind);
  }
}
