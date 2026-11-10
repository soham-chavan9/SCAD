# Identity headers and token (T1.9)

Every request the gateway forwards to an app carries (AGENTS §10):

```
X-SCAD-User-Email:  verified email
X-SCAD-User-Id:     stable user uuid
X-SCAD-User-Name:   display name (may be empty)
X-SCAD-Identity:    JWT (EdDSA / Ed25519), 60 s lifetime
```

The gateway strips any client-sent `X-SCAD-*` header first (INV3), and only the
gateway can reach an app's network. So an app may simply **trust the plain
headers**. Verify the JWT when you want proof that doesn't depend on the network,
e.g. when you forward the identity to another service.

## Token

- Header: `{"alg": "EdDSA", "kid": "<key id>"}`. The `kid` is the RFC 7638 JWK
  thumbprint of the signing key, so a new key always gets a new `kid`.
- Claims: `iss` (`http://auth.{BASE_DOMAIN}`), `aud` (your app id), `sub` (user
  id), `email`, `name`, `iat`, `exp` (60 s after `iat`).
- Keys: `http://auth.{BASE_DOMAIN}/.well-known/jwks.json`, served with
  `Cache-Control: public, max-age=300`. During a rotation it lists more than
  one key.

## Verifying (Node, no dependencies)

`examples/echo-identity/verify.js` does this with only `node:crypto`, so the
image builds with `--network=none`:

```js
import { remoteJwks, verifyIdentityJwt } from "./verify.js";

const jwks = remoteJwks("http://auth.localhost:8080/.well-known/jwks.json");

export async function currentUser(req) {
  const token = req.headers["x-scad-identity"];
  // Picks the key by `kid`; refetches the JWKS once if the kid is new (rotation).
  const claims = await verifyIdentityJwt(String(token), jwks, {
    audience: process.env.SCAD_APP_ID,
    issuer: "http://auth.localhost:8080",
  });
  return { id: claims.sub, email: claims.email, name: claims.name };
}
```

With `jose` (if your app vendors it):

```js
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("http://auth.localhost:8080/.well-known/jwks.json"));
const { payload } = await jwtVerify(token, jwks, {
  issuer: "http://auth.localhost:8080",
  audience: appId,
  algorithms: ["EdDSA"],
});
```

Always check `aud`: a token minted for another app must not be accepted by
yours.

## Rotating the signing key (operator)

1. Generate a new pair:
   `openssl genpkey -algorithm ed25519 -out new.pem && openssl pkey -in new.pem -pubout -out new.pub.pem`
2. Move the **current public** key into `JWT_PREVIOUS_PUBLIC_KEY` (several PEM
   blocks may be concatenated), and set `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` to
   the new pair.
3. Restart the gateway. It signs with the new key at once and publishes both
   keys in the JWKS. Apps that cached the old JWKS see an unknown `kid` and
   refetch.
4. After at least 10 minutes (60 s token lifetime + 5 min JWKS cache, with
   margin), remove `JWT_PREVIOUS_PUBLIC_KEY` and restart. Tokens signed with the
   old key stop verifying.

If the private key leaked, skip the wait: remove the old key right away. Apps
reject old tokens as soon as their JWKS cache refreshes (≤ 5 min).

Tests: `apps/gateway/src/identity/rotation.test.ts` (rotation end to end, unknown
kid, example refetch), `apps/gateway/src/identity/echo-verify.test.ts`, and the
JWKS cache header in `apps/gateway/src/gateway.integration.test.ts`.
