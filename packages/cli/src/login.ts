import { ScadClient } from "@scad/api-client";
import { saveConfig, type ScadConfig } from "./config.js";

export type LoginOptions = {
  apiUrl: string;
  /** When set, auto-approve the device code (local/dev / tests). */
  approveEmail?: string;
  pollMs?: number;
  configPath?: string;
  fetchImpl?: typeof fetch;
  onUserCode?: (info: { userCode: string; verificationUri: string }) => void;
};

export async function loginWithDeviceCode(opts: LoginOptions): Promise<ScadConfig> {
  const client = new ScadClient({
    baseUrl: opts.apiUrl,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const device = await client.startDeviceAuth();
  opts.onUserCode?.({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
  });

  if (opts.approveEmail) {
    await client.approveDevice(device.user_code, opts.approveEmail);
  }

  const intervalMs = Math.max(1, device.interval) * 1000;
  const pollMs = opts.pollMs ?? intervalMs;
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    const result = await client.pollDeviceToken(device.device_code);
    if ("pat" in result) {
      const config: ScadConfig = { apiUrl: opts.apiUrl, pat: result.pat };
      await saveConfig(config, opts.configPath);
      return config;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error("Login timed out waiting for device authorization");
}
