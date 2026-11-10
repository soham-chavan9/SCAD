import { exportJWK, type CryptoKey, type JWK } from "jose";
import {
  generateEd25519KeyPair,
  identityKeyId,
  importPrivateKeyPem,
  importPublicKeyPem,
  normalizePemFromEnv,
} from "@scad/shared";

export type IdentityKeyMaterial = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Key id of the signing key (RFC 7638 thumbprint unless set explicitly). */
  kid: string;
  publicJwk: JWK;
  /** Retired keys still published in the JWKS during a rotation (verify only, T1.9). */
  previousJwks: JWK[];
};

async function publicJwkOf(publicKey: CryptoKey, kid: string): Promise<JWK> {
  const jwk = await exportJWK(publicKey);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid, use: "sig", alg: "EdDSA" } as JWK;
}

async function toMaterial(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  kid: string | undefined,
  previous: CryptoKey[] = [],
): Promise<IdentityKeyMaterial> {
  const currentKid = kid ?? (await identityKeyId(publicKey));
  const publicJwk = await publicJwkOf(publicKey, currentKid);
  const previousJwks: JWK[] = [];
  for (const key of previous) {
    const prevKid = await identityKeyId(key);
    if (prevKid === currentKid || previousJwks.some((j) => j.kid === prevKid)) continue;
    previousJwks.push(await publicJwkOf(key, prevKid));
  }
  return { privateKey, publicKey, kid: currentKid, publicJwk, previousJwks };
}

/** Ephemeral key pair for tests / local when PEMs are unset. */
export async function generateEphemeralIdentityKeys(kid?: string): Promise<IdentityKeyMaterial> {
  const { privateKey, publicKey } = await generateEd25519KeyPair();
  return toMaterial(privateKey, publicKey, kid);
}

/** Load Ed25519 PEM pair from env (JWT_PRIVATE_KEY + JWT_PUBLIC_KEY). */
export async function loadIdentityKeysFromPemPair(
  privateKeyPem: string,
  publicKeyPem: string,
  kid?: string,
): Promise<IdentityKeyMaterial> {
  const privateKey = await importPrivateKeyPem(privateKeyPem, "JWT_PRIVATE_KEY");
  const publicKey = await importPublicKeyPem(publicKeyPem, "JWT_PUBLIC_KEY");
  return toMaterial(privateKey, publicKey, kid);
}

/** Split `JWT_PREVIOUS_PUBLIC_KEY` (one or more concatenated SPKI PEM blocks). */
async function parsePreviousKeys(value: string | undefined): Promise<CryptoKey[]> {
  if (!value?.trim()) return [];
  const blocks = value
    .replace(/\\n/g, "\n")
    .match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g);
  if (!blocks) throw new Error("JWT_PREVIOUS_PUBLIC_KEY has no PEM public key block");
  return Promise.all(
    blocks.map((b) => importPublicKeyPem(normalizePemFromEnv(b), "JWT_PREVIOUS_PUBLIC_KEY")),
  );
}

export async function resolveIdentityKeys(env: {
  privateKeyPem?: string;
  publicKeyPem?: string;
  /** Previous public key(s), still served in the JWKS while a rotation settles. */
  previousPublicKeysPem?: string;
  kid?: string;
}): Promise<IdentityKeyMaterial> {
  const previous = await parsePreviousKeys(env.previousPublicKeysPem);
  if (env.privateKeyPem?.trim() && env.publicKeyPem?.trim()) {
    const privateKey = await importPrivateKeyPem(env.privateKeyPem, "JWT_PRIVATE_KEY");
    const publicKey = await importPublicKeyPem(env.publicKeyPem, "JWT_PUBLIC_KEY");
    return toMaterial(privateKey, publicKey, env.kid, previous);
  }
  const { privateKey, publicKey } = await generateEd25519KeyPair();
  return toMaterial(privateKey, publicKey, env.kid, previous);
}
