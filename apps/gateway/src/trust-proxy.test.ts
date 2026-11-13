import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@scad/control-plane";
import { buildGateway, parseTrustProxy, type GatewayInstance } from "./app.js";
import { generateEphemeralIdentityKeys } from "./identity/keys.js";
import { MemoryMailer } from "./mail/mailer.js";

/** T3.1: behind Caddy, per-IP limits must see the viewer's IP, not Caddy's. */
describe("gateway behind the TLS front", () => {
  const dbBundle = createDb(process.env["DATABASE_URL"] ?? "postgres://scad:scad@localhost:5432/scad_test");
  const gateways: GatewayInstance[] = [];

  afterAll(async () => {
    await Promise.all(gateways.map((g) => g.close()));
    await dbBundle.client.end({ timeout: 5 });
  });

  async function ipSeenBy(trustProxy: string | undefined, xff: string): Promise<string> {
    const gateway = await buildGateway({
      db: dbBundle.db,
      baseDomain: "scad.example.org",
      identity: null,
      resolver: { resolve: async () => null },
      keys: await generateEphemeralIdentityKeys(),
      mailer: new MemoryMailer(),
      ...(trustProxy !== undefined ? { trustProxy } : {}),
    });
    gateways.push(gateway);
    gateway.get("/__test/ip", async (request) => ({ ip: request.ip }));
    const res = await gateway.inject({
      method: "GET",
      url: "/__test/ip",
      headers: { "x-forwarded-for": xff },
      remoteAddress: "172.18.0.5",
    });
    return (res.json() as { ip: string }).ip;
  }

  it("uses the client IP Caddy appended when Caddy's address is trusted", async () => {
    expect(await ipSeenBy("172.18.0.5", "1.2.3.4, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("does not trust a caller that is not the pinned proxy", async () => {
    expect(await ipSeenBy("172.31.250.10", "203.0.113.9")).toBe("172.18.0.5");
  });

  it("ignores X-Forwarded-For when no proxy is trusted", async () => {
    expect(await ipSeenBy(undefined, "203.0.113.9")).toBe("172.18.0.5");
  });

  it("parses GATEWAY_TRUST_PROXY", () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy("")).toBeUndefined();
    expect(parseTrustProxy("172.31.250.10")).toBe("172.31.250.10");
    expect(parseTrustProxy(" 172.16.0.0/12 , ::1 ")).toBe("172.16.0.0/12,::1");
    expect(() => parseTrustProxy("1")).toThrow(/GATEWAY_TRUST_PROXY/);
    expect(() => parseTrustProxy("true")).toThrow(/GATEWAY_TRUST_PROXY/);
  });
});
