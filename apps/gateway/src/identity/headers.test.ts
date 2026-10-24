import { describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
import { verifyIdentityJwt } from "@scad/shared";
import { buildUpstreamHeaders, jwksResponse } from "./headers.js";
import { generateEphemeralIdentityKeys } from "./keys.js";

describe("identity headers (INV3)", () => {
  it("strips forged X-SCAD-* and injects verified identity", async () => {
    const keys = await generateEphemeralIdentityKeys();
    const headers = await buildUpstreamHeaders({
      incoming: {
        "x-scad-user-email": "attacker@evil.test",
        "x-scad-user-id": "forged",
        "x-forwarded-for": "1.2.3.4",
        accept: "application/json",
      },
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "alice@example.com",
        handle: "alice",
        displayName: "Alice",
        status: "active",
      },
      appId: "22222222-2222-4222-8222-222222222222",
      issuer: "http://auth.localhost:8080",
      keys,
    });

    expect(headers["x-scad-user-email"]).toBe("alice@example.com");
    expect(headers["x-scad-user-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(headers["x-scad-user-name"]).toBe("Alice");
    expect(headers["x-forwarded-for"]).toBe("1.2.3.4");
    expect(headers["accept"]).toBe("application/json");

    const verified = await verifyIdentityJwt(headers["x-scad-identity"]!, keys.publicKey, {
      issuer: "http://auth.localhost:8080",
      audience: "22222222-2222-4222-8222-222222222222",
    });
    expect(verified.email).toBe("alice@example.com");

    await expect(
      verifyIdentityJwt(headers["x-scad-identity"]!, keys.publicKey, {
        issuer: "http://auth.localhost:8080",
        audience: "wrong-app",
      }),
    ).rejects.toThrow();
  });

  it("drops forged unknown X-SCAD-* headers (any case, duplicated)", async () => {
    const keys = await generateEphemeralIdentityKeys();
    const headers = await buildUpstreamHeaders({
      incoming: {
        "X-SCAD-Role": "admin",
        "x-ScAd-Extra": ["one", "two"],
        "X-scad-internal-secret": "leak-me",
        "x-scad-user-email": "forged@evil.test",
        accept: "application/json",
      },
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "alice@example.com",
        handle: "alice",
        displayName: "Alice",
        status: "active",
      },
      appId: "22222222-2222-4222-8222-222222222222",
      issuer: "http://auth.localhost:8080",
      keys,
    });

    const injected = new Set([
      "x-scad-user-email",
      "x-scad-user-id",
      "x-scad-user-name",
      "x-scad-identity",
    ]);
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith("x-scad-")) {
        expect(injected.has(key.toLowerCase())).toBe(true);
      }
    }
    expect(headers["x-scad-role"]).toBeUndefined();
    expect(headers["x-scad-extra"]).toBeUndefined();
    expect(headers["x-scad-internal-secret"]).toBeUndefined();
    expect(headers["X-SCAD-Role"]).toBeUndefined();
    expect(headers["x-scad-user-email"]).toBe("alice@example.com");
    expect(headers["accept"]).toBe("application/json");
  });

  it("JWKS public key verifies the identity JWT", async () => {
    const keys = await generateEphemeralIdentityKeys("kid-1");
    const headers = await buildUpstreamHeaders({
      incoming: {},
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "alice@example.com",
        handle: "alice",
        displayName: "",
        status: "active",
      },
      appId: "app-1",
      issuer: "http://auth.localhost:8080",
      keys,
    });

    const jwks = createLocalJWKSet(jwksResponse(keys));
    const { payload } = await jwtVerify(headers["x-scad-identity"]!, jwks, {
      issuer: "http://auth.localhost:8080",
      audience: "app-1",
    });
    expect(payload["email"]).toBe("alice@example.com");
    expect(keys.publicJwk.kid).toBe("kid-1");

    await expect(
      jwtVerify(headers["x-scad-identity"]!, jwks, {
        issuer: "http://auth.localhost:8080",
        audience: "wrong-audience",
      }),
    ).rejects.toThrow();
  });
});
