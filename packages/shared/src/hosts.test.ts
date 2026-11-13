import { describe, expect, it } from "vitest";
import { apiBaseUrlFor, apiHostFor, authHostFor, isLocalBaseDomain, schemeFor } from "./hosts.js";

describe("platform hosts from BASE_DOMAIN (T3.1)", () => {
  it("derives auth and api hosts", () => {
    expect(authHostFor("scad.duckdns.org")).toBe("auth.scad.duckdns.org");
    expect(apiHostFor("scad.duckdns.org")).toBe("api.scad.duckdns.org");
    expect(apiHostFor("localhost:8080")).toBe("api.localhost:8080");
  });

  it("uses https outside localhost", () => {
    expect(schemeFor("scad.duckdns.org")).toBe("https");
    expect(schemeFor("localhost:8080")).toBe("http");
    expect(apiBaseUrlFor("scad.duckdns.org")).toBe("https://api.scad.duckdns.org");
    expect(apiBaseUrlFor("https://scad.duckdns.org/")).toBe("https://api.scad.duckdns.org");
  });

  it("does not treat localhost as a substring as local", () => {
    expect(isLocalBaseDomain("localhost.evil.com")).toBe(false);
    expect(isLocalBaseDomain("notlocalhost")).toBe(false);
    expect(isLocalBaseDomain("foo.localhost:8080")).toBe(true);
  });
});
