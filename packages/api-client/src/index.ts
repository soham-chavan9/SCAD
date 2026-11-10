export const PACKAGE_NAME = "api-client" as const;

export {
  ScadApiError,
  ScadClient,
  type AdminAppRef,
  type AdminUser,
  type AppShares,
  type AuditEvent,
  type Invite,
  type EnvEntry,
  type EnvUpdate,
  type AppSummary,
  type DeviceCodeResponse,
  type PublishResponse,
  type ReleaseStatus,
  type ScadClientOptions,
} from "./client.js";
