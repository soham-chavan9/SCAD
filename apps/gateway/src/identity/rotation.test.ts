import { generateEd25519KeyPair, signIdentityJwt, verifyIdentityJwtWithJwks } from "@scad/shared";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS example app, no type declarations
import { verifyWithRemoteJwks } from "../../../../examples/echo-identity/verify.js";
import { jwksResponse } from "./headers.js";
import { generateEphemeralIdentityKeys, resolveIdentityKeys } from "./keys.js";

const claims = {
  iss: "http://auth.localhost:8080",
  aud: "app-1",
  sub: "user-1",
  email: "a@example.com",
  name: "A",
};
const expected = { issuer: claims.iss, audience: claims.aud };

type RemoteVerify = (
  token: string,
  jwks: (opts?: { force?: boolean }) => Promise<unknown>,
  opts?: { audience?: string; issuer?: string },
) => Promise<Record<string, unknown>>;
const verifyRemote = verifyWithRemoteJwks as RemoteVerify;

describe("identity key rotation via kid (T1.9)", () => {
  it("kid defaults to the key's RFC 7638 thumbprint, so each key gets its own kid", async () => {
    const a = await generateEphemeralIdentityKeys();
    const b = await generateEphemeralIdentityKeys();
    expect(a.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.kid).not.toBe(b.kid);
    expect(a.publicJwk.kid).toBe(a.kid);
  });

  it("rotation: JWKS lists new + previous keys, tokens from both verify, then the old one is retired", async () => {
    const oldPair = await generateEd25519KeyPair();
    const newPair = await generateEd25519KeyPair();

    const before = await resolveIdentityKeys({
      privateKeyPem: oldPair.privateKeyPem,
      publicKeyPem: oldPair.publicKeyPem,
    });
    const oldToken = await signIdentityJwt(before.privateKey, claims, { kid: before.kid });

    // Runbook step 2: new pair current, old public key kept for verification.
    const during = await resolveIdentityKeys({
      privateKeyPem: newPair.privateKeyPem,
      publicKeyPem: newPair.publicKeyPem,
      previousPublicKeysPem: oldPair.publicKeyPem,
    });
    expect(during.kid).not.toBe(before.kid);
    const jwksDuring = jwksResponse(during);
    expect(jwksDuring.keys.map((k) => k["kid"])).toEqual([during.kid, before.kid]);

    const newToken = await signIdentityJwt(during.privateKey, claims, { kid: during.kid });
    await expect(verifyIdentityJwtWithJwks(newToken, jwksDuring, expected)).resolves.toMatchObject({ sub: "user-1" });
    await expect(verifyIdentityJwtWithJwks(oldToken, jwksDuring, expected)).resolves.toMatchObject({ sub: "user-1" });

    // Runbook step 4: previous key removed. Old tokens stop verifying; new ones still do.
    const after = await resolveIdentityKeys({
      privateKeyPem: newPair.privateKeyPem,
      publicKeyPem: newPair.publicKeyPem,
    });
    const jwksAfter = jwksResponse(after);
    expect(jwksAfter.keys).toHaveLength(1);
    await expect(verifyIdentityJwtWithJwks(oldToken, jwksAfter, expected)).rejects.toThrow();
    await expect(verifyIdentityJwtWithJwks(newToken, jwksAfter, expected)).resolves.toBeTruthy();
  });

  it("several previous keys can be given as concatenated PEM blocks", async () => {
    const [p1, p2, cur] = await Promise.all([
      generateEd25519KeyPair(),
      generateEd25519KeyPair(),
      generateEd25519KeyPair(),
    ]);
    const keys = await resolveIdentityKeys({
      privateKeyPem: cur.privateKeyPem,
      publicKeyPem: cur.publicKeyPem,
      previousPublicKeysPem: `${p1.publicKeyPem}\n${p2.publicKeyPem}`.replace(/\n/g, "\\n"),
    });
    expect(jwksResponse(keys).keys).toHaveLength(3);
  });

  it("JWKS entries never carry private material", async () => {
    const oldPair = await generateEd25519KeyPair();
    const cur = await generateEd25519KeyPair();
    const keys = await resolveIdentityKeys({
      privateKeyPem: cur.privateKeyPem,
      publicKeyPem: cur.publicKeyPem,
      previousPublicKeysPem: oldPair.publicKeyPem,
    });
    for (const k of jwksResponse(keys).keys) {
      expect(k).not.toHaveProperty("d");
      expect(k).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig", alg: "EdDSA" });
    }
  });

  it("rejects a token without kid or with an unknown kid", async () => {
    const keys = await generateEphemeralIdentityKeys();
    const noKid = await signIdentityJwt(keys.privateKey, claims);
    await expect(verifyIdentityJwtWithJwks(noKid, jwksResponse(keys), expected)).rejects.toThrow(/kid/);
    const stranger = await generateEphemeralIdentityKeys();
    const unknown = await signIdentityJwt(stranger.privateKey, claims, { kid: stranger.kid });
    await expect(verifyIdentityJwtWithJwks(unknown, jwksResponse(keys), expected)).rejects.toThrow();
  });

  it("the example app refetches the JWKS once when it sees a new kid", async () => {
    const before = await generateEphemeralIdentityKeys();
    const after = await generateEphemeralIdentityKeys();
    let served = jwksResponse(before);
    let fetches = 0;
    let cached: unknown = null;
    const jwks = async (opts: { force?: boolean } = {}) => {
      if (!cached || opts.force) {
        fetches += 1;
        cached = served;
      }
      return cached;
    };
    await jwks(); // the app warmed its cache before the rotation
    served = jwksResponse(after);
    const token = await signIdentityJwt(after.privateKey, claims, { kid: after.kid });
    const out = await verifyRemote(token, jwks, { audience: "app-1" });
    expect(out["sub"]).toBe("user-1");
    expect(fetches).toBe(2);
  });
});
