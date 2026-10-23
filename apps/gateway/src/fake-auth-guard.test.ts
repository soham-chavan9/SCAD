import { describe, expect, it } from "vitest";
import { assertFakeAuthAllowed } from "./fake-auth-guard.js";

describe("assertFakeAuthAllowed", () => {
  it("allows fake auth on localhost BASE_DOMAIN", () => {
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "localhost:8080" }),
    ).not.toThrow();
  });

  it("allows fake auth off for any domain", () => {
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: false, baseDomain: "apps.example.com" }),
    ).not.toThrow();
  });

  it("refuses to start when fake auth is on and BASE_DOMAIN is not localhost-based", () => {
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "scad.example.com" }),
    ).toThrow(/GATEWAY_FAKE_AUTH=1 is refused/);
  });
});
