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

  it("session cookies are host-only (no Domain attribute)", () => {
    const opts = sessionCookieOptions("localhost:8080");
    expect(opts).not.toHaveProperty("domain");
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(false);
  });
});
