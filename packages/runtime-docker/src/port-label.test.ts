import { describe, expect, it } from "vitest";
import { portFromLabel } from "./docker-provider.js";

describe("portFromLabel", () => {
  it("does not invent port 8080 when the label is missing", () => {
    expect(() => portFromLabel(undefined)).toThrow(/missing scad.port/);
    expect(() => portFromLabel("")).toThrow(/missing scad.port/);
  });

  it("reads the label that deploy wrote", () => {
    expect(portFromLabel("3456")).toBe(3456);
    expect(() => portFromLabel("nope")).toThrow(/invalid scad.port/);
  });
});
