import { isHandle, isSlug } from "@scad/shared";

export type ParsedHost =
  | { kind: "auth" }
  | { kind: "app"; slug: string; ownerHandle: string }
  | { kind: "unknown" };

/** Parse Host against BASE_DOMAIN (`{slug}.{owner}.{BASE_DOMAIN}` or `auth.{BASE_DOMAIN}`). */
export function parseHost(hostHeader: string | undefined, baseDomain: string): ParsedHost {
  if (!hostHeader) {
    return { kind: "unknown" };
  }
  // Strip optional port only when BASE_DOMAIN has no port (rare); normally Host includes port.
  const host = hostHeader.trim().toLowerCase();
  if (host === `auth.${baseDomain}`) {
    return { kind: "auth" };
  }
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) {
    return { kind: "unknown" };
  }
  const prefix = host.slice(0, -suffix.length);
  const parts = prefix.split(".");
  if (parts.length !== 2) {
    return { kind: "unknown" };
  }
  const [slug, ownerHandle] = parts;
  if (!slug || !ownerHandle) {
    return { kind: "unknown" };
  }
  // INV11: reject bad slug/handle everywhere hostnames are used.
  if (!isSlug(slug) || !isHandle(ownerHandle)) {
    return { kind: "unknown" };
  }
  return { kind: "app", slug, ownerHandle };
}

export function appHost(slug: string, ownerHandle: string, baseDomain: string): string {
  return `${slug}.${ownerHandle}.${baseDomain}`;
}

export function authHost(baseDomain: string): string {
  return `auth.${baseDomain}`;
}

export function isLocalhostBase(baseDomain: string): boolean {
  return baseDomain.startsWith("localhost") || baseDomain.includes(".localhost");
}
