export const PACKAGE_NAME = "api-client" as const;

export {
  ScadApiError,
  ScadClient,
  type AppShares,
  type AppSummary,
  type DeviceCodeResponse,
  type PublishResponse,
  type ReleaseStatus,
  type ScadClientOptions,
} from "./client.js";
