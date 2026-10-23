export const PACKAGE_NAME = "cli" as const;

export { defaultConfigPath, loadConfig, saveConfig, type ScadConfig } from "./config.js";
export { loginWithDeviceCode, type LoginOptions } from "./login.js";
export { publishDir, type PublishOptions, type PublishResult } from "./publish.js";
export { createPublishTarball, PUBLISH_MAX_BYTES } from "./tar-dir.js";
