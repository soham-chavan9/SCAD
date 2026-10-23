import { describe, expect, it } from "vitest";
import { assertFakeAuthAllowed } from "./fake-auth-guard.js";

describe("assertFakeAuthAllowed", () => {
  it("allows fake auth off on any domain", () => {
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: false, baseDomain: "apps.example.com" }),
    ).not.toThrow();
  });

  it("allows fake auth on localhost BASE_DOMAIN", () => {
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "localhost:8080" }),
    ).not.toThrow();
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "localhost" }),
    ).not.toThrow();
  });

  it("refuses fake auth when BASE_DOMAIN is not localhost-based", () => {
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "scad.example.com" }),
    ).toThrow(/GATEWAY_FAKE_AUTH/);
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "apps.prod.example" }),
    ).toThrow(/localhost-based/);
  });
});
