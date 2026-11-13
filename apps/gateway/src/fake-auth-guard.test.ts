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

  it("refuses fake auth when localhost is only a substring", () => {
    for (const baseDomain of [
      "localhost.evil.com",
      "evil.localhost.attacker.com",
      "app.localhost.example.com",
      "notlocalhost",
    ]) {
      expect(() => assertFakeAuthAllowed({ fakeAuth: true, baseDomain })).toThrow(
        /GATEWAY_FAKE_AUTH/,
      );
    }
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "foo.localhost:8080" }),
    ).not.toThrow();
  });

  it("refuses fake auth in production even on localhost (T3.1)", () => {
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: true, baseDomain: "localhost:8080", production: true }),
    ).toThrow(/production/);
    expect(() =>
      assertFakeAuthAllowed({ fakeAuth: false, baseDomain: "scad.example.org", production: true }),
    ).not.toThrow();
  });
});
