import { createDb } from "@scad/control-plane";
import { GithubIdentityProvider } from "./auth/github.js";
import { FakeIdentityProvider } from "./auth/identity.js";
import { buildGateway } from "./app.js";
import { assertFakeAuthAllowed } from "./fake-auth-guard.js";
import { resolveIdentityKeys } from "./identity/keys.js";
import { createHttpAppResolver } from "./resolve.js";

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const baseDomain = process.env["BASE_DOMAIN"] ?? "localhost:8080";
  const internalSecret = required("INTERNAL_SECRET");
  const controlPlaneUrl = process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:4000";
  const port = Number(process.env["PORT"] ?? 8080);
  const fakeAuth = process.env["GATEWAY_FAKE_AUTH"] === "1";

  assertFakeAuthAllowed({ fakeAuth, baseDomain });

  const { db } = createDb(databaseUrl);
  const keys = await resolveIdentityKeys({
    ...(process.env["JWT_PRIVATE_KEY"]
      ? { privateKeyPem: process.env["JWT_PRIVATE_KEY"] }
      : {}),
    ...(process.env["JWT_PUBLIC_KEY"] ? { publicKeyPem: process.env["JWT_PUBLIC_KEY"] } : {}),
  });

  const identity = fakeAuth
    ? new FakeIdentityProvider()
    : new GithubIdentityProvider({
        clientId: required("GITHUB_CLIENT_ID"),
        clientSecret: required("GITHUB_CLIENT_SECRET"),
      });

  const gateway = await buildGateway({
    db,
    baseDomain,
    identity,
    keys,
    resolver: createHttpAppResolver({
      controlPlaneUrl,
      internalSecret,
    }),
    allowDevLogin: fakeAuth,
  });

  await gateway.listen({ port, host: "0.0.0.0" });
  console.log(`gateway listening on ${port} (BASE_DOMAIN=${baseDomain})`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
