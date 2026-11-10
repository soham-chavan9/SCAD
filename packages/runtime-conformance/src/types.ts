/** RuntimeProvider contract (AGENTS §4). */

export type DeploySpec = {
  appId: string;
  imageRef: string;
  port: number;
  /**
   * Container argv (not a host shell string). Passed as Docker Cmd/Entrypoint
   * array — never interpolated into `/bin/sh -c` on the host or in the runtime.
   */
  start?: string[];
  env: Record<string, string>;
  egressAllow: string[];
  limits: {
    memoryMb: number;
    cpuShares: number;
    diskGb: number;
    pids: number;
  };
};

export type MachineRef = {
  appId: string;
  providerId: string;
};

/** Reachable from the gateway only (not the public internet). */
export type Reachable = {
  host: string;
  port: number;
};

export type MachineStatus = "running" | "stopped" | "missing";

export interface RuntimeProvider {
  /** Create per-app network + volume (idempotent). */
  ensureApp(appId: string, diskGb: number): Promise<void>;
  /** Replace any running release with this image/config. */
  deploy(spec: DeploySpec): Promise<MachineRef>;
  start(m: MachineRef): Promise<void>;
  stop(m: MachineRef): Promise<void>;
  status(m: MachineRef): Promise<MachineStatus>;
  address(m: MachineRef): Promise<Reachable>;
  logs(m: MachineRef, opts: { follow: boolean; tail?: number }): AsyncIterable<string>;
  remove(appId: string, opts: { deleteVolume: boolean }): Promise<void>;
}

/**
 * Optional driver capabilities. The control plane's scheduled jobs use them
 * when a driver has them, and skip that job when it does not.
 */
export interface RuntimeCapabilities {
  /** Every app the runtime holds resources for (orphan reaper, T2.5). */
  listApps?(): Promise<{ appId: string; resources: string[] }[]>;
  /** Stop the app if its `/data` volume is over its size limit (measured quota, T1.3). */
  enforceVolumeQuota?(m: MachineRef): Promise<"ok" | "stopped">;
  /**
   * Re-attach the platform's own containers (gateway, egress proxy) to the
   * app's private network. Idempotent. Recreating either container drops it
   * from every app network; wake and the periodic sweep call this to heal.
   */
  reconnect?(m: MachineRef): Promise<void>;
  /** Bytes used by the app's `/data` volume and its limit (usage page, T2.7). */
  volumeUsage?(appId: string): Promise<{ usedBytes: number; limitBytes: number }>;
}

/** A runtime driver plus whatever optional capabilities it has. */
export type ManagedRuntime = RuntimeProvider & RuntimeCapabilities;
