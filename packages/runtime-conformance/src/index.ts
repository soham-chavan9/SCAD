export const PACKAGE_NAME = "runtime-conformance" as const;

export type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  Reachable,
  RuntimeProvider,
} from "./types.js";

export {
  registerRuntimeConformance,
  type ConformanceContext,
  type ConformanceFactory,
} from "./suite.js";
