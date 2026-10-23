import { describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
import { generateEd25519KeyPair, signIdentityJwt } from "@scad/shared";
import { jwksResponse } from "./headers.js";
import { loadIdentityKeysFromPemPair } from "./keys.js";

describe("identity keys from env PEMs", () => {
  it("loads single-line \\n-escaped keys, verifies via JWKS, rejects wrong audience", async () => {
    const generated = await generateEd25519KeyPair();
    const privateEscaped = generated.privateKeyPem.replace(/\n/g, "\\n");
    const publicEscaped = generated.publicKeyPem.replace(/\n/g, "\\n");
    expect(privateEscaped.includes("\n")).toBe(false);
    expect(publicEscaped.includes("\n")).toBe(false);

    const keys = await loadIdentityKeysFromPemPair(privateEscaped, publicEscaped, "kid-env");
    const claims = {
      iss: "http://auth.localhost:8080",
      aud: "app-correct",
      sub: "user-1",
      email: "a@b.co",
      name: "A",
    };
    const token = await signIdentityJwt(keys.privateKey, claims, { kid: keys.kid });

    const jwks = createLocalJWKSet(jwksResponse(keys));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: claims.iss,
      audience: claims.aud,
    });
    expect(payload["email"]).toBe(claims.email);
    expect(payload.sub).toBe(claims.sub);

    await expect(
      jwtVerify(token, jwks, {
        issuer: claims.iss,
        audience: "app-wrong",
      }),
    ).rejects.toThrow();
  });

  it("surfaces JWT_PRIVATE_KEY in parse errors without echoing the value", async () => {
    const { publicKeyPem } = await generateEd25519KeyPair();
    await expect(
      loadIdentityKeysFromPemPair("-----BEGIN PRIVATE KEY-----\nbad\n-----END PRIVATE KEY-----", publicKeyPem),
    ).rejects.toThrow(/JWT_PRIVATE_KEY/);
  });
});
