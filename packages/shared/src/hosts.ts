import { normalizeBaseDomain } from "./app-url.js";

/**
 * Platform hostnames derived from BASE_DOMAIN (T3.1). Every public URL comes
 * from BASE_DOMAIN, so moving from `localhost:8080` to a real domain is a
 * config change.
 */

/** True only for `localhost` or `*.localhost`, optional numeric port. */
export function isLocalBaseDomain(baseDomain: string): boolean {
  const host = normalizeBaseDomain(baseDomain)
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost");
}

/** `http` on localhost, `https` everywhere else. */
export function schemeFor(baseDomain: string): "http" | "https" {
  return isLocalBaseDomain(baseDomain) ? "http" : "https";
}

/** Sign-in host: `auth.{BASE_DOMAIN}`. */
export function authHostFor(baseDomain: string): string {
  return `auth.${normalizeBaseDomain(baseDomain).toLowerCase()}`;
}

/** Control-plane API host for the CLI and MCP server: `api.{BASE_DOMAIN}`. */
export function apiHostFor(baseDomain: string): string {
  return `api.${normalizeBaseDomain(baseDomain).toLowerCase()}`;
}

/** Public control-plane URL, e.g. `https://api.example.duckdns.org`. */
export function apiBaseUrlFor(baseDomain: string): string {
  return `${schemeFor(baseDomain)}://${apiHostFor(baseDomain)}`;
}
