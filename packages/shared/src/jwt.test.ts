import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair, signIdentityJwt, verifyIdentityJwt } from "./jwt.js";

describe("identity JWT (EdDSA)", () => {
  it("round-trips sign and verify", async () => {
    const { privateKey, publicKey } = await generateEd25519KeyPair();
    const claims = {
      iss: "http://auth.localhost:8080",
      aud: "app-11111111-1111-4111-8111-111111111111",
      sub: "user-22222222-2222-4222-8222-222222222222",
      email: "builder@example.com",
      name: "Builder",
    };
    const token = await signIdentityJwt(privateKey, claims);
    const verified = await verifyIdentityJwt(token, publicKey, {
      issuer: claims.iss,
      audience: claims.aud,
    });
    expect(verified.sub).toBe(claims.sub);
    expect(verified.email).toBe(claims.email);
    expect(verified.name).toBe(claims.name);
    expect(verified.iss).toBe(claims.iss);
    expect(verified.aud).toBe(claims.aud);
  });

  it("rejects wrong audience", async () => {
    const { privateKey, publicKey } = await generateEd25519KeyPair();
    const token = await signIdentityJwt(privateKey, {
      iss: "http://auth.localhost:8080",
      aud: "app-correct",
      sub: "user-1",
      email: "a@b.co",
      name: "",
    });
    await expect(
      verifyIdentityJwt(token, publicKey, {
        issuer: "http://auth.localhost:8080",
        audience: "app-wrong",
      }),
    ).rejects.toThrow();
  });

  it("rejects expired tokens", async () => {
    const { privateKey, publicKey } = await generateEd25519KeyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdentityJwt(
      privateKey,
      {
        iss: "http://auth.localhost:8080",
        aud: "app-1",
        sub: "user-1",
        email: "a@b.co",
        name: "",
      },
      { expiresInSeconds: 60, now: now - 120 },
    );
    await expect(
      verifyIdentityJwt(token, publicKey, {
        issuer: "http://auth.localhost:8080",
        audience: "app-1",
      }),
    ).rejects.toThrow();
  });
});
