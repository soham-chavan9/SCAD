import { signIdentityJwt } from "@scad/shared";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS example app, no type declarations
import { verifyIdentityJwt } from "../../../../examples/echo-identity/verify.js";
import { jwksResponse } from "./headers.js";
import { generateEphemeralIdentityKeys } from "./keys.js";

type Verify = (
  token: string,
  jwks: unknown,
  opts?: { audience?: string; issuer?: string; nowSec?: number },
) => Record<string, unknown>;
const verifyJwt = verifyIdentityJwt as Verify;

const claims = {
  iss: "http://auth.localhost:8080",
  aud: "app-1",
  sub: "user-1",
  email: "a@example.com",
  name: "A",
};

describe("examples/echo-identity dependency-free verifier", () => {
  it("verifies a gateway-signed identity JWT against the JWKS", async () => {
    const keys = await generateEphemeralIdentityKeys();
    const token = await signIdentityJwt(keys.privateKey, claims, { kid: keys.kid });
    const out = verifyJwt(token, jwksResponse(keys), { audience: "app-1" });
    expect(out["email"]).toBe("a@example.com");
  });

  it("rejects a wrong audience, an expired token, and another key", async () => {
    const keys = await generateEphemeralIdentityKeys();
    const other = await generateEphemeralIdentityKeys();
    const token = await signIdentityJwt(keys.privateKey, claims, { kid: keys.kid });
    expect(() => verifyJwt(token, jwksResponse(keys), { audience: "app-2" })).toThrow(/audience/);
    expect(() =>
      verifyJwt(token, jwksResponse(keys), { nowSec: Math.floor(Date.now() / 1000) + 120 }),
    ).toThrow(/expired/);
    expect(() => verifyJwt(token, jwksResponse(other))).toThrow(/no matching key|signature/);
  });
});
