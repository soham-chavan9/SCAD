/**
 * Verify an X-SCAD-Identity JWT (EdDSA / Ed25519) with only Node built-ins.
 * No npm dependencies, so the image builds with `docker build --network=none`.
 */
import { createPublicKey, verify } from "node:crypto";

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/**
 * @param {string} token compact JWT
 * @param {{ keys: Array<Record<string, unknown>> }} jwks JWKS document
 * @param {{ audience?: string, issuer?: string, nowSec?: number }} [opts]
 * @returns {Record<string, unknown>} verified claims
 */
export function verifyIdentityJwt(token, jwks, opts = {}) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [h, p, s] = parts;
  const header = b64urlJson(h);
  if (header.alg !== "EdDSA") throw new Error(`unexpected alg ${header.alg}`);
  const jwk = (jwks.keys ?? []).find(
    (k) => k.kty === "OKP" && k.crv === "Ed25519" && (!header.kid || k.kid === header.kid),
  );
  if (!jwk) throw new Error("no matching key in JWKS");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("signature verification failed");
  const claims = b64urlJson(p);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("token expired");
  if (opts.audience !== undefined && claims.aud !== opts.audience) {
    throw new Error("unexpected audience");
  }
  if (opts.issuer !== undefined && claims.iss !== opts.issuer) {
    throw new Error("unexpected issuer");
  }
  return claims;
}

/** Fetch a JWKS document, caching it for `ttlMs`. */
export function remoteJwks(url, ttlMs = 60_000) {
  let cached = null;
  let fetchedAt = 0;
  return async () => {
    if (cached && Date.now() - fetchedAt < ttlMs) return cached;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    cached = await res.json();
    fetchedAt = Date.now();
    return cached;
  };
}
