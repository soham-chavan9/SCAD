import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptEnvValue,
  encryptEnvValue,
  keyIdOf,
  parseMasterKey,
  rewrapEnvValue,
  type MasterKeyRing,
} from "./crypto.js";

const ring = (current: Buffer, ...previous: Buffer[]): MasterKeyRing => ({ current, previous });
const ctx = { appId: "11111111-1111-4111-8111-111111111111", key: "API_TOKEN" };

describe("env secret envelope encryption (T1.6, INV7)", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it("round-trips and never contains the plaintext", () => {
    const blob = encryptEnvValue(ring(k1), ctx, "s3cr3t-value-123");
    expect(blob.includes(Buffer.from("s3cr3t-value-123"))).toBe(false);
    expect(decryptEnvValue(ring(k1), ctx, blob)).toBe("s3cr3t-value-123");
  });

  it("uses a fresh data key and nonce per record", () => {
    const a = encryptEnvValue(ring(k1), ctx, "same");
    const b = encryptEnvValue(ring(k1), ctx, "same");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects tampering", () => {
    const blob = encryptEnvValue(ring(k1), ctx, "value");
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff;
    expect(() => decryptEnvValue(ring(k1), ctx, blob)).toThrow();
  });

  it("is bound to its app and key (no swapping ciphertexts between rows)", () => {
    const blob = encryptEnvValue(ring(k1), ctx, "value");
    expect(() =>
      decryptEnvValue(ring(k1), { ...ctx, key: "OTHER" }, blob),
    ).toThrow();
    expect(() =>
      decryptEnvValue(ring(k1), { ...ctx, appId: "22222222-2222-4222-8222-222222222222" }, blob),
    ).toThrow();
  });

  it("fails with the wrong master key", () => {
    const blob = encryptEnvValue(ring(k1), ctx, "value");
    expect(() => decryptEnvValue(ring(k2), ctx, blob)).toThrow(/master key/i);
  });

  it("rotation: rewrap moves a record to the new key; previous key decrypts until rewrapped", () => {
    const blob = encryptEnvValue(ring(k1), ctx, "value");
    // New key current, old key still listed as previous: old records still readable.
    expect(decryptEnvValue(ring(k2, k1), ctx, blob)).toBe("value");
    const rewrapped = rewrapEnvValue(ring(k2, k1), ctx, blob);
    expect(rewrapped.subarray(1, 9).equals(keyIdOf(k2))).toBe(true);
    // After rewrap the old key is no longer needed.
    expect(decryptEnvValue(ring(k2), ctx, rewrapped)).toBe("value");
    expect(() => decryptEnvValue(ring(k1), ctx, rewrapped)).toThrow();
  });

  it("parses MASTER_KEY as exactly 32 bytes of base64", () => {
    const key = randomBytes(32);
    expect(parseMasterKey(key.toString("base64")).equals(key)).toBe(true);
    expect(() => parseMasterKey("")).toThrow();
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
