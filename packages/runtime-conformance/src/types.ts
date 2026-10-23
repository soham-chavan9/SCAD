/** RuntimeProvider contract (AGENTS §4). */

export type DeploySpec = {
  appId: string;
  imageRef: string;
  port: number;
  start?: string;
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
