import { spawn } from "node:child_process";
import { ScadApiError, ScadClient } from "@scad/api-client";
import { assertFinalAppUrl, makeError } from "@scad/shared";
import { loadConfig } from "./config.js";

export type OpenAppOptions = {
  app: string;
  configPath?: string;
  apiUrl?: string;
  pat?: string;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to opening the system browser. */
  openUrl?: (url: string) => Promise<void>;
};

function requireFinalUrl(url: string): string {
  try {
    return assertFinalAppUrl(url);
  } catch {
    throw new ScadApiError(
      500,
      makeError(
        "INTERNAL",
        "Could not determine the app host URL",
        "Ensure BASE_DOMAIN is set and your account has a valid handle.",
        {},
      ),
    );
  }
}

/** Open a URL with the platform default browser (no extra dependency). */
export async function openInBrowser(url: string): Promise<void> {
  const args =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(args[0], args[1], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

export async function openApp(opts: OpenAppOptions): Promise<{ url: string }> {
  const config = await loadConfig(opts.configPath);
  const apiUrl = opts.apiUrl ?? config?.apiUrl;
  const pat = opts.pat ?? config?.pat;
  if (!apiUrl || !pat) {
    throw new Error("Not logged in. Run `scad login` first.");
  }

  const client = new ScadClient({
    baseUrl: apiUrl,
    pat,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const { app } = await client.getApp(opts.app);
  const url = requireFinalUrl(app.url);
  const open = opts.openUrl ?? openInBrowser;
  await open(url);
  return { url };
}
