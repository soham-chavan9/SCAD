import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
} from "jose";

/** Default identity JWT lifetime (AGENTS §10). */
export const IDENTITY_JWT_TTL_SECONDS = 60;

export type IdentityClaims = {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name: string;
};

export type VerifiedIdentity = IdentityClaims & {
  iat: number;
  exp: number;
};

export type SignIdentityOptions = {
  /** Lifetime in seconds. Defaults to 60. */
  expiresInSeconds?: number;
  /** Optional key id for JWKS rotation (T1.9). */
  kid?: string;
  /** Unix seconds used for iat/exp (tests). Defaults to now. */
  now?: number;
};

export async function generateEd25519KeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  privateKeyPem: string;
  publicKeyPem: string;
}> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicKeyPem = await exportSPKI(publicKey);
  return { privateKey, publicKey, privateKeyPem, publicKeyPem };
}

/**
 * Normalize a PEM from env: accept real multi-line PEMs or a single line with
 * literal `\n` escapes. Idempotent when newlines are already real.
 */
export function normalizePemFromEnv(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

export async function importPrivateKeyPem(
  pem: string,
  envVarName = "JWT_PRIVATE_KEY",
): Promise<CryptoKey> {
  const normalized = normalizePemFromEnv(pem);
  try {
    return await importPKCS8(normalized, "EdDSA");
  } catch {
    throw new Error(
      `${envVarName} could not be parsed as an Ed25519 PKCS8 PEM`,
    );
  }
}

export async function importPublicKeyPem(
  pem: string,
  envVarName = "JWT_PUBLIC_KEY",
): Promise<CryptoKey> {
  const normalized = normalizePemFromEnv(pem);
  try {
    return await importSPKI(normalized, "EdDSA");
  } catch {
    throw new Error(
      `${envVarName} could not be parsed as an Ed25519 SPKI PEM`,
    );
  }
}

export async function signIdentityJwt(
  privateKey: CryptoKey,
  claims: IdentityClaims,
  options: SignIdentityOptions = {},
): Promise<string> {
  const expiresInSeconds = options.expiresInSeconds ?? IDENTITY_JWT_TTL_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const header: { alg: "EdDSA"; kid?: string } = { alg: "EdDSA" };
  if (options.kid !== undefined) {
    header.kid = options.kid;
  }

  return new SignJWT({
    email: claims.email,
    name: claims.name,
  })
    .setProtectedHeader(header)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(privateKey);
}

export async function verifyIdentityJwt(
  token: string,
  publicKey: CryptoKey,
  expected: { issuer: string; audience: string },
): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: expected.issuer,
    audience: expected.audience,
    algorithms: ["EdDSA"],
  });

  const email = payload["email"];
  const name = payload["name"];
  if (typeof email !== "string" || typeof name !== "string") {
    throw new Error("identity JWT missing email or name claim");
  }
  if (typeof payload.iss !== "string" || typeof payload.sub !== "string") {
    throw new Error("identity JWT missing iss or sub");
  }
  if (payload.aud === undefined) {
    throw new Error("identity JWT missing aud");
  }
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  if (typeof aud !== "string") {
    throw new Error("identity JWT has invalid aud");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("identity JWT missing iat or exp");
  }

  return {
    iss: payload.iss,
    aud,
    sub: payload.sub,
    email,
    name,
    iat: payload.iat,
    exp: payload.exp,
  };
}
