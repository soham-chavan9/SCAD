import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption for app env vars (T1.6, INV7).
 *
 * Each record gets its own random 32-byte data key (DEK). The value is
 * encrypted with the DEK (AES-256-GCM, random 12-byte nonce); the DEK is
 * encrypted ("wrapped") with MASTER_KEY (AES-256-GCM, its own nonce). Both
 * use `scad-env:v1:{appId}:{key}` as additional authenticated data, so a
 * ciphertext cannot be moved to another app or key.
 *
 * Rotating MASTER_KEY only rewraps DEKs; values are never re-encrypted.
 *
 * Layout: version(1) | kekId(8) | wrapNonce(12) | wrappedDek(32) | wrapTag(16)
 *         | dataNonce(12) | dataTag(16) | ciphertext(n)
 */

const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEK_ID_BYTES = 8;
const HEADER_BYTES = 1 + KEK_ID_BYTES + NONCE_BYTES + KEY_BYTES + TAG_BYTES + NONCE_BYTES + TAG_BYTES;

/** Current MASTER_KEY plus previous ones still accepted for decryption during rotation. */
export type MasterKeyRing = { current: Buffer; previous: Buffer[] };

export type EnvContext = { appId: string; key: string };

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptError";
  }
}

/** Parse a base64 MASTER_KEY; must decode to exactly 32 bytes. */
export function parseMasterKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`MASTER_KEY must be 32 bytes, base64-encoded (got ${key.length} bytes). Generate one with: openssl rand -base64 32`);
  }
  return key;
}

/** Non-secret 8-byte fingerprint that says which master key wrapped a record. */
export function keyIdOf(masterKey: Buffer): Buffer {
  return createHash("sha256").update("scad-kek-id:").update(masterKey).digest().subarray(0, KEK_ID_BYTES);
}

function aad(ctx: EnvContext): Buffer {
  return Buffer.from(`scad-env:v${VERSION}:${ctx.appId}:${ctx.key}`, "utf8");
}

function seal(key: Buffer, plaintext: Buffer, ad: Buffer): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(ad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

function open(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer, ad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

type Parsed = {
  kekId: Buffer;
  wrapNonce: Buffer;
  wrappedDek: Buffer;
  wrapTag: Buffer;
  dataNonce: Buffer;
  dataTag: Buffer;
  ciphertext: Buffer;
};

function parse(blob: Buffer): Parsed {
  if (blob.length < HEADER_BYTES || blob[0] !== VERSION) {
    throw new SecretDecryptError("Unrecognized secret format");
  }
  let at = 1;
  const take = (n: number) => {
    const part = blob.subarray(at, at + n);
    at += n;
    return part;
  };
  return {
    kekId: take(KEK_ID_BYTES),
    wrapNonce: take(NONCE_BYTES),
    wrappedDek: take(KEY_BYTES),
    wrapTag: take(TAG_BYTES),
    dataNonce: take(NONCE_BYTES),
    dataTag: take(TAG_BYTES),
    ciphertext: blob.subarray(at),
  };
}

function wrap(masterKey: Buffer, dek: Buffer, ad: Buffer): Buffer {
  const w = seal(masterKey, dek, ad);
  return Buffer.concat([keyIdOf(masterKey), w.nonce, w.ciphertext, w.tag]);
}

function unwrapDek(keys: MasterKeyRing, p: Parsed, ad: Buffer): Buffer {
  const masterKey = [keys.current, ...keys.previous].find((k) => keyIdOf(k).equals(p.kekId));
  if (!masterKey) {
    throw new SecretDecryptError("No configured master key matches this secret (was MASTER_KEY rotated without MASTER_KEY_PREVIOUS?)");
  }
  try {
    return open(masterKey, p.wrapNonce, p.wrappedDek, p.wrapTag, ad);
  } catch {
    throw new SecretDecryptError("Secret failed authentication");
  }
}

export function encryptEnvValue(keys: MasterKeyRing, ctx: EnvContext, value: string): Buffer {
  const ad = aad(ctx);
  const dek = randomBytes(KEY_BYTES);
  try {
    const data = seal(dek, Buffer.from(value, "utf8"), ad);
    return Buffer.concat([
      Buffer.from([VERSION]),
      wrap(keys.current, dek, ad),
      data.nonce,
      data.tag,
      data.ciphertext,
    ]);
  } finally {
    dek.fill(0);
  }
}

export function decryptEnvValue(keys: MasterKeyRing, ctx: EnvContext, blob: Buffer): string {
  const ad = aad(ctx);
  const p = parse(blob);
  const dek = unwrapDek(keys, p, ad);
  try {
    return open(dek, p.dataNonce, p.ciphertext, p.dataTag, ad).toString("utf8");
  } catch {
    throw new SecretDecryptError("Secret failed authentication");
  } finally {
    dek.fill(0);
  }
}

/** Re-wrap a record's data key under `keys.current`. The value ciphertext is unchanged. */
export function rewrapEnvValue(keys: MasterKeyRing, ctx: EnvContext, blob: Buffer): Buffer {
  const ad = aad(ctx);
  const p = parse(blob);
  const dek = unwrapDek(keys, p, ad);
  try {
    return Buffer.concat([
      Buffer.from([VERSION]),
      wrap(keys.current, dek, ad),
      p.dataNonce,
      p.dataTag,
      p.ciphertext,
    ]);
  } finally {
    dek.fill(0);
  }
}
