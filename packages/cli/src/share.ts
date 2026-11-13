import { ScadClient, type AppShares, type AppSummary, type RollbackResult, type Visibility } from "@scad/api-client";
import { loadConfig } from "./config.js";

export type ClientOptions = {
  configPath?: string;
  apiUrl?: string;
  pat?: string;
  fetchImpl?: typeof fetch;
};

export async function client(opts: ClientOptions): Promise<ScadClient> {
  const config = await loadConfig(opts.configPath);
  const apiUrl = opts.apiUrl ?? config?.apiUrl;
  const pat = opts.pat ?? config?.pat;
  if (!apiUrl || !pat) {
    throw new Error("Not logged in. Run `scad login` first.");
  }
  return new ScadClient({
    baseUrl: apiUrl,
    pat,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

/** Add `email` to the app's allowlist. The person may not have an account yet. */
export async function shareApp(
  opts: ClientOptions & { app: string; email: string },
): Promise<{ app_id: string; email: string }> {
  return (await client(opts)).shareApp(opts.app, opts.email);
}

export async function unshareApp(
  opts: ClientOptions & { app: string; email: string },
): Promise<{ app_id: string; email: string; removed: boolean }> {
  return (await client(opts)).unshareApp(opts.app, opts.email);
}

export async function listApps(opts: ClientOptions): Promise<AppSummary[]> {
  return (await (await client(opts)).listApps()).apps;
}

export async function listShares(opts: ClientOptions & { app: string }): Promise<AppShares> {
  return (await client(opts)).listShares(opts.app);
}

export async function setVisibility(
  opts: ClientOptions & { app: string; visibility: Visibility },
): Promise<{ id: string; slug: string; visibility: Visibility }> {
  return (await (await client(opts)).setVisibility(opts.app, opts.visibility)).app;
}

/** T3.6: go back to the release before the current one ("that update broke it"). */
export async function rollbackApp(opts: ClientOptions & { app: string }): Promise<RollbackResult> {
  return (await client(opts)).rollback(opts.app);
}
