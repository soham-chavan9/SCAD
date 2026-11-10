import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@scad/control-plane";
import { buildGateway, type GatewayInstance } from "./app.js";
import { authHost } from "./host.js";
import { generateEphemeralIdentityKeys } from "./identity/keys.js";
import { MemoryMailer } from "./mail/mailer.js";

const BASE_DOMAIN = "localhost:8080";
const returnTo = encodeURIComponent("http://board.olive.localhost:8080/");

/** T2.9: a fresh install runs with email sign-in only, no GitHub OAuth app needed. */
describe("gateway without GitHub configured", () => {
  let dbBundle: Db;
  let gateway: GatewayInstance;

  beforeAll(async () => {
    // These routes never query; the client connects lazily.
    dbBundle = createDb(
      process.env["DATABASE_URL"] ?? "postgres://scad:scad@localhost:5432/scad_test",
    );
    gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity: null,
      resolver: { resolve: async () => null },
      keys: await generateEphemeralIdentityKeys(),
      mailer: new MemoryMailer(),
    });
  });

  afterAll(async () => {
    await gateway?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  it("the login page offers only the emailed link", async () => {
    const res = await gateway.inject({
      method: "GET",
      url: `/login?return_to=${returnTo}`,
      headers: { host: authHost(BASE_DOMAIN) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("/login/github");
    expect(res.body).toContain("Email me a sign-in link");
  });

  it("/login/github explains that GitHub sign-in is not set up", async () => {
    const res = await gateway.inject({
      method: "GET",
      url: `/login/github?return_to=${returnTo}`,
      headers: { host: authHost(BASE_DOMAIN) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatch(/GitHub sign-in is not set up/);
  });

  it("the OAuth callback is refused too", async () => {
    const res = await gateway.inject({
      method: "GET",
      url: "/oauth/github/callback?code=x&state=y",
      headers: { host: authHost(BASE_DOMAIN), cookie: "scad_oauth_state=y" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
