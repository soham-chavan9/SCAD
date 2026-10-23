export const PACKAGE_NAME = "api-client" as const;

export {
  ScadApiError,
  ScadClient,
  type DeviceCodeResponse,
  type PublishResponse,
  type ReleaseStatus,
  type ScadClientOptions,
} from "./client.js";
