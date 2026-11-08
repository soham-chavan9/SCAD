#!/usr/bin/env node
/**
 * Echo SCAD identity headers and verify X-SCAD-Identity against JWKS.
 * Env: PORT (default 8080), JWKS_URL (optional — when set, JWT is verified).
 */
import { createServer } from "node:http";
import { remoteJwks, verifyWithRemoteJwks } from "./verify.js";

const port = Number(process.env.PORT ?? 8080);
const jwksUrl = process.env.JWKS_URL;

const jwks = jwksUrl ? remoteJwks(jwksUrl) : null;

const server = createServer(async (req, res) => {
  const email = req.headers["x-scad-user-email"] ?? null;
  const userId = req.headers["x-scad-user-id"] ?? null;
  const name = req.headers["x-scad-user-name"] ?? null;
  const identity = req.headers["x-scad-identity"] ?? null;

  let jwt = null;
  let jwtError = null;
  if (identity && jwks) {
    try {
      jwt = await verifyWithRemoteJwks(String(identity), jwks);
    } catch (err) {
      jwtError = err instanceof Error ? err.message : String(err);
    }
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      {
        email,
        userId,
        name,
        identity,
        jwt,
        jwtError,
      },
      null,
      2,
    ),
  );
});

server.listen(port, "0.0.0.0", () => {
  console.log(`echo-identity listening on ${port}`);
});
