export const PACKAGE_NAME = "api-client" as const;

export {
  ScadApiError,
  ScadClient,
  type AdminAppRef,
  type AdminUser,
  type AppShares,
  type AppUsage,
  type UsageReport,
  type AuditEvent,
  type Invite,
  type EnvEntry,
  type EnvUpdate,
  type AppSummary,
  type DeviceCodeResponse,
  type PublishResponse,
  type ReleaseStatus,
  type RollbackResult,
  type Visibility,
  type ScadClientOptions,
} from "./client.js";
