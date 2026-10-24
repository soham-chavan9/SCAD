import { describe, expect, it } from "vitest";
import { isPlatformUpgradePath } from "./websocket.js";

describe("websocket platform paths", () => {
  it("does not proxy /__scad upgrades to the app", () => {
    expect(isPlatformUpgradePath("/__scad")).toBe(true);
    expect(isPlatformUpgradePath("/__scad/should-not-proxy")).toBe(true);
    expect(isPlatformUpgradePath("/__scad/callback?code=x")).toBe(true);
    expect(isPlatformUpgradePath("/")).toBe(false);
    expect(isPlatformUpgradePath("/socket")).toBe(false);
  });
});