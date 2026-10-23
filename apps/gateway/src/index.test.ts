import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, parseHost, sessionCookieOptions } from "./index.js";

describe("@scad/gateway", () => {
  it("exports package name and parses hosts", () => {
    expect(PACKAGE_NAME).toBe("gateway");
    expect(parseHost("auth.localhost:8080", "localhost:8080")).toEqual({ kind: "auth" });
    expect(parseHost("hello.alice.localhost:8080", "localhost:8080")).toEqual({
      kind: "app",
      slug: "hello",
      ownerHandle: "alice",
    });
  });

  it("INV11: rejects bad slug/handle in Host", () => {
    const base = "localhost:8080";
    // Host is lowercased (DNS case-fold); uppercase alone is not a Host-layer reject.
    // Reject over-length, under-length, shell chars, spaces, unicode lookalikes.
    expect(parseHost(`ab.alice.${base}`, base).kind).toBe("unknown");
    expect(parseHost(`evil;rm.alice.${base}`, base).kind).toBe("unknown");
    expect(parseHost(`hello.al ice.${base}`, base).kind).toBe("unknown");
    expect(parseHost(`${"a".repeat(41)}.alice.${base}`, base).kind).toBe("unknown");
    expect(parseHost(`hello.аlice.${base}`, base).kind).toBe("unknown");
    expect(parseHost(`hello..${base}`, base).kind).toBe("unknown");
  });

  it("session cookies are host-only (no Domain attribute)", () => {
    const opts = sessionCookieOptions("localhost:8080");
    expect(opts).not.toHaveProperty("domain");
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(false);
  });
});
