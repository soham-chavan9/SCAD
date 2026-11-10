export const PACKAGE_NAME = "cli" as const;

export { defaultConfigPath, loadConfig, saveConfig, type ScadConfig } from "./config.js";
export { loginWithDeviceCode, type LoginOptions } from "./login.js";
export { openApp, openInBrowser, type OpenAppOptions } from "./open-app.js";
export { publishDir, type PublishOptions, type PublishResult } from "./publish.js";
export { createPublishTarball, PUBLISH_MAX_BYTES } from "./tar-dir.js";
export { listApps, listShares, setVisibility, shareApp, unshareApp } from "./share.js";
export { listEnv, parseAssignments, setEnv, unsetEnv } from "./env.js";
export { streamLogs } from "./logs.js";
export {
  adminAudit,
  adminDeleteApp,
  adminInviteAdd,
  adminInviteRemove,
  adminInvites,
  adminSuspendApp,
  adminSuspendUser,
  adminUsage,
  adminUsers,
  formatUsage,
} from "./admin.js";
