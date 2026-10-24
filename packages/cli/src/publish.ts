import { basename, resolve } from "node:path";
import { ScadApiError, ScadClient } from "@scad/api-client";
import { assertFinalAppUrl, makeError } from "@scad/shared";
import { loadConfig } from "./config.js";
import { createPublishTarball } from "./tar-dir.js";

export type PublishOptions = {
  dir: string;
  name?: string;
  configPath?: string;
  apiUrl?: string;
  pat?: string;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  onStatus?: (line: string) => void;
};

export type PublishResult = {
  url: string;
  appId: string;
  releaseId: string;
  status: "ready";
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
        "Ensure BASE_DOMAIN is set and your account has a valid handle, then republish.",
        {},
      ),
    );
  }
}

export async function publishDir(opts: PublishOptions): Promise<PublishResult> {
  const dir = resolve(opts.dir);
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

  opts.onStatus?.(`Packing ${dir}`);
  const tarball = await createPublishTarball(dir);
  const name = opts.name ?? basename(dir);

  opts.onStatus?.(`Uploading ${tarball.byteLength} bytes as ${name}`);
  const published = await client.publish({ tarball, name });
  const finalUrl = requireFinalUrl(published.url);
  opts.onStatus?.(`Build started: release ${published.release.id}`);
  opts.onStatus?.(`URL (when ready): ${finalUrl}`);

  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const release = await client.getRelease(published.release.id);
    if (release.status === "ready") {
      opts.onStatus?.(finalUrl);
      return {
        url: finalUrl,
        appId: published.app.id,
        releaseId: release.id,
        status: "ready",
      };
    }
    if (release.status === "failed") {
      const err = release.error;
      const message = err?.message ?? "Publish failed";
      const hint = err?.hint ?? "See build log";
      const logTail = (err?.details?.["log_tail"] as string[] | undefined) ?? release.log_tail;
      const wrapped = new ScadApiError(400, {
        code: err?.code ?? "BUILD_FAILED",
        message,
        hint,
        details: { log_tail: logTail },
      });
      throw wrapped;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error("Timed out waiting for build");
}
