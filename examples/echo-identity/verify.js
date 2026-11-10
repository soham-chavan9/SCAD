/**
 * Verify an X-SCAD-Identity JWT (EdDSA / Ed25519) with only Node built-ins.
 * No npm dependencies, so the image builds with `docker build --network=none`.
 */
import { createPublicKey, verify } from "node:crypto";

class UnknownKeyError extends Error {
  constructor() {
    super("no matching key in JWKS");
    this.name = "UnknownKeyError";
  }
}

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
  const candidates = (jwks.keys ?? []).filter((k) => k.kty === "OKP" && k.crv === "Ed25519");
  // During a key rotation the JWKS lists several keys: pick by kid (T1.9).
  const jwk = header.kid
    ? candidates.find((k) => k.kid === header.kid)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!jwk) throw new UnknownKeyError();
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

/**
 * Verify with a cached JWKS; if the token names a key the cache doesn't have
 * (the gateway rotated its key), refetch once and retry.
 * @param {string} token
 * @param {(opts?: { force?: boolean }) => Promise<{ keys: Array<Record<string, unknown>> }>} jwks from remoteJwks()
 * @param {{ audience?: string, issuer?: string, nowSec?: number }} [opts]
 */
export async function verifyWithRemoteJwks(token, jwks, opts = {}) {
  try {
    return verifyIdentityJwt(token, await jwks(), opts);
  } catch (err) {
    if (!(err instanceof UnknownKeyError)) throw err;
    return verifyIdentityJwt(token, await jwks({ force: true }), opts);
  }
}

/** Fetch a JWKS document, caching it for `ttlMs` (pass `{ force: true }` to refetch). */
export function remoteJwks(url, ttlMs = 60_000) {
  let cached = null;
  let fetchedAt = 0;
  return async ({ force = false } = {}) => {
    if (!force && cached && Date.now() - fetchedAt < ttlMs) return cached;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    cached = await res.json();
    fetchedAt = Date.now();
    return cached;
  };
}
