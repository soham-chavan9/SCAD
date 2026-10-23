import type { IncomingHttpHeaders } from "node:http";
import { signIdentityJwt } from "@scad/shared";
import type { GatewayUser } from "../auth/users.js";
import type { IdentityKeyMaterial } from "./keys.js";

export const SCAD_HEADER_PREFIX = "x-scad-";

/** Strip every inbound X-SCAD-* header (INV3), then inject gateway identity. */
export async function buildUpstreamHeaders(opts: {
  incoming: IncomingHttpHeaders;
  user: GatewayUser;
  appId: string;
  issuer: string;
  keys: IdentityKeyMaterial;
}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const [rawKey, value] of Object.entries(opts.incoming)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (key.startsWith(SCAD_HEADER_PREFIX)) {
      continue;
    }
    // Hop-by-hop / host handled by proxy
    if (
      key === "connection" ||
      key === "keep-alive" ||
      key === "transfer-encoding" ||
      key === "te" ||
      key === "trailer" ||
      key === "upgrade" ||
      key === "proxy-authorization" ||
      key === "proxy-authenticate" ||
      key === "host" ||
      key === "content-length"
    ) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  const jwt = await signIdentityJwt(
    opts.keys.privateKey,
    {
      iss: opts.issuer,
      aud: opts.appId,
      sub: opts.user.id,
      email: opts.user.email,
      name: opts.user.displayName,
    },
    { kid: opts.keys.kid },
  );

  out["x-scad-user-email"] = opts.user.email;
  out["x-scad-user-id"] = opts.user.id;
  out["x-scad-user-name"] = opts.user.displayName;
  out["x-scad-identity"] = jwt;

  return out;
}

export function jwksResponse(keys: IdentityKeyMaterial): { keys: JWKPublic[] } {
  return { keys: [keys.publicJwk as JWKPublic] };
}

type JWKPublic = Record<string, unknown>;
