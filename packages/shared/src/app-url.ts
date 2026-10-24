import { isHandle, isSlug } from "./validators.js";

export type AppUrlErrorReason = "missing_host" | "invalid_parts" | "template";

export class AppUrlError extends Error {
  readonly reason: AppUrlErrorReason;

  constructor(reason: AppUrlErrorReason, message: string) {
    super(message);
    this.name = "AppUrlError";
    this.reason = reason;
  }
}

/**
 * Reject template / placeholder strings. A printed publish URL must be a real
 * absolute http(s) URL with no `{` or `}` characters.
 */
export function assertFinalAppUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new AppUrlError("missing_host", "App URL is empty");
  }
  if (trimmed.includes("{") || trimmed.includes("}")) {
    throw new AppUrlError(
      "template",
      "App URL must be a concrete host, not a {placeholder} template",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppUrlError("invalid_parts", "App URL is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppUrlError("invalid_parts", "App URL must use http or https");
  }
  if (!parsed.hostname || parsed.hostname.includes("{") || parsed.hostname.includes("}")) {
    throw new AppUrlError("missing_host", "App URL is missing a concrete host");
  }
  return trimmed;
}

/** Strip accidental scheme/trailing slash from BASE_DOMAIN (host[:port]). */
export function normalizeBaseDomain(baseDomain: string): string {
  return baseDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

/**
 * Build the public app URL (AGENTS D9 / §6).
 * Never returns a template string; throws AppUrlError if the host cannot be determined.
 */
export function formatAppUrl(opts: {
  slug: string;
  ownerHandle: string;
  baseDomain: string;
}): string {
  const base = normalizeBaseDomain(opts.baseDomain ?? "");
  if (!base) {
    throw new AppUrlError(
      "missing_host",
      "BASE_DOMAIN is missing; cannot determine the app host",
    );
  }
  if (base.includes("{") || base.includes("}")) {
    throw new AppUrlError("template", "BASE_DOMAIN must not contain {placeholders}");
  }
  if (!opts.slug?.trim() || !opts.ownerHandle?.trim()) {
    throw new AppUrlError(
      "missing_host",
      "App slug and owner handle are required to build the app URL",
    );
  }
  if (!isSlug(opts.slug) || !isHandle(opts.ownerHandle)) {
    throw new AppUrlError(
      "invalid_parts",
      "App URL requires a validated slug and owner handle (INV11)",
    );
  }
  const host = `${opts.slug}.${opts.ownerHandle}.${base}`;
  const scheme = base.includes("localhost") ? "http" : "https";
  return assertFinalAppUrl(`${scheme}://${host}`);
}
