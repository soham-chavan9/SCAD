import type { DeploySpec } from "@scad/runtime-conformance";
import type Docker from "dockerode";

/**
 * The one container profile every app process runs under (INV6), used by
 * both deploy and the builder's smoke check so they cannot drift apart.
 */
export type HardenedHostConfigInput = {
  limits: DeploySpec["limits"];
  networkMode: string;
  /** The app's real volume (deploy), or a throwaway size-capped tmpfs (smoke). */
  dataMount: { volume: string } | { tmpfsMb: number };
  /** OCI runtime name (`runsc` for gVisor); omit for Docker's default. */
  ociRuntime?: string | undefined;
  logConfig?: Docker.HostConfig["LogConfig"];
};

export function hardenedHostConfig(input: HardenedHostConfigInput): Docker.HostConfig {
  const memoryBytes = input.limits.memoryMb * 1024 * 1024;
  const tmpfs: Record<string, string> = { "/tmp": "rw,noexec,nosuid,nodev,size=64m" };
  const binds: string[] = [];
  if ("volume" in input.dataMount) {
    binds.push(`${input.dataMount.volume}:/data:rw`);
  } else {
    tmpfs["/data"] = `rw,nosuid,nodev,size=${input.dataMount.tmpfsMb}m,mode=1777`;
  }
  return {
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Memory: memoryBytes,
    // Same as Memory: no swap on top of the limit, so a memory hog is OOM-killed.
    MemorySwap: memoryBytes,
    CpuShares: input.limits.cpuShares,
    PidsLimit: input.limits.pids,
    NetworkMode: input.networkMode,
    // No PortBindings / PublishAllPorts: apps are reachable only on their internal network.
    Binds: binds,
    Tmpfs: tmpfs,
    ...(input.ociRuntime ? { Runtime: input.ociRuntime } : {}),
    ...(input.logConfig ? { LogConfig: input.logConfig } : {}),
  };
}

const RUNSC = "runsc";

/**
 * Pick the OCI runtime from what Docker reports and `SCAD_OCI_RUNTIME`:
 * - `auto` (default): gVisor `runsc` when Docker has it, else Docker's default.
 * - `runsc`: require gVisor; refuse to run apps without it.
 * - `runc`: Docker's default even if gVisor is installed.
 * Returns the runtime name to set, or undefined for Docker's default.
 */
export function chooseOciRuntime(available: string[], requested: string | undefined): string | undefined {
  const mode = (requested ?? "auto").trim() || "auto";
  if (mode !== "auto" && mode !== RUNSC && mode !== "runc") {
    throw new Error(`SCAD_OCI_RUNTIME must be auto, runsc, or runc (got ${JSON.stringify(mode).slice(0, 40)})`);
  }
  const hasRunsc = available.includes(RUNSC);
  if (mode === "runc") return undefined;
  if (mode === RUNSC && !hasRunsc) {
    throw new Error("SCAD_OCI_RUNTIME=runsc but Docker has no runsc runtime; install gVisor (see docs/hardening.md)");
  }
  return hasRunsc ? RUNSC : undefined;
}
