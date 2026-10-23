export const PACKAGE_NAME = "runtime-docker" as const;

export { DockerRuntimeProvider, type DockerRuntimeOptions } from "./docker-provider.js";
export {
  appLabels,
  assertAppId,
  containerName,
  LABEL_APP,
  LABEL_PORT,
  LABEL_ROLE,
  networkName,
  volumeName,
} from "./names.js";
