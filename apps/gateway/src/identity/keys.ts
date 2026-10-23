import { exportJWK, type CryptoKey, type JWK } from "jose";
import {
  generateEd25519KeyPair,
  importPrivateKeyPem,
  importPublicKeyPem,
} from "@scad/shared";

export type IdentityKeyMaterial = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
  publicJwk: JWK;
};

async function toMaterial(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  kid: string,
): Promise<IdentityKeyMaterial> {
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  publicJwk.alg = "EdDSA";
  return { privateKey, publicKey, kid, publicJwk };
}

/** Ephemeral key pair for tests / local when PEMs are unset. */
export async function generateEphemeralIdentityKeys(
  kid = "scad-ed25519-1",
): Promise<IdentityKeyMaterial> {
  const { privateKey, publicKey } = await generateEd25519KeyPair();
  return toMaterial(privateKey, publicKey, kid);
}

/** Load Ed25519 PEM pair from env (JWT_PRIVATE_KEY + JWT_PUBLIC_KEY). */
export async function loadIdentityKeysFromPemPair(
  privateKeyPem: string,
  publicKeyPem: string,
  kid = "scad-ed25519-1",
): Promise<IdentityKeyMaterial> {
  const privateKey = await importPrivateKeyPem(privateKeyPem);
  const publicKey = await importPublicKeyPem(publicKeyPem);
  return toMaterial(privateKey, publicKey, kid);
}

export async function resolveIdentityKeys(env: {
  privateKeyPem?: string;
  publicKeyPem?: string;
  kid?: string;
}): Promise<IdentityKeyMaterial> {
  const kid = env.kid ?? "scad-ed25519-1";
  if (env.privateKeyPem?.trim() && env.publicKeyPem?.trim()) {
    return loadIdentityKeysFromPemPair(env.privateKeyPem, env.publicKeyPem, kid);
  }
  return generateEphemeralIdentityKeys(kid);
}
