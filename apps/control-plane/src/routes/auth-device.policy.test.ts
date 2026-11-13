import { describe, expect, it } from "vitest";
import { emailMayApprove, isLoopbackIp } from "./auth-device.js";

describe("device approval policy", () => {
  it("denies approval when the operator allowlist is empty", () => {
    expect(emailMayApprove(new Set(), "anyone@example.com")).toBe(false);
  });

  it("allows only emails on a non-empty allowlist", () => {
    const allow = new Set(["op@example.com"]);
    expect(emailMayApprove(allow, "op@example.com")).toBe(true);
    expect(emailMayApprove(allow, "other@example.com")).toBe(false);
  });

  it("treats only loopback as a local approval client", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("10.0.0.5")).toBe(false);
    expect(isLoopbackIp("192.168.1.20")).toBe(false);
    expect(isLoopbackIp(undefined)).toBe(false);
  });
});

describe("device approval behind the TLS front (T3.1)", () => {
  it("treats any forwarding header as a remote caller", async () => {
    const { cameThroughProxy } = await import("./auth-device.js");
    expect(cameThroughProxy({})).toBe(false);
    expect(cameThroughProxy({ "x-forwarded-for": "127.0.0.1" })).toBe(true);
    expect(cameThroughProxy({ forwarded: "for=127.0.0.1" })).toBe(true);
    expect(cameThroughProxy({ "x-real-ip": "127.0.0.1" })).toBe(true);
    expect(cameThroughProxy({ via: "1.1 Caddy" })).toBe(true);
  });
});
