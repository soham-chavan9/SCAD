import { isUuid } from "@scad/shared";

const LABEL_APP = "scad.app_id";
const LABEL_ROLE = "scad.role";
const LABEL_PORT = "scad.port";

export function assertAppId(appId: string): void {
  if (!isUuid(appId)) {
    throw new Error(`appId must be a UUID v4, got: ${appId}`);
  }
}

export function networkName(appId: string): string {
  assertAppId(appId);
  return `scad-net-${appId}`;
}

export function volumeName(appId: string): string {
  assertAppId(appId);
  return `scad-data-${appId}`;
}

export function containerName(appId: string): string {
  assertAppId(appId);
  return `scad-run-${appId}`;
}

export function appLabels(appId: string): Record<string, string> {
  assertAppId(appId);
  return {
    [LABEL_APP]: appId,
    [LABEL_ROLE]: "app",
  };
}

export { LABEL_APP, LABEL_PORT, LABEL_ROLE };
