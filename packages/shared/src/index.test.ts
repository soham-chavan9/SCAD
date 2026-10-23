import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, parseManifest, ERROR_CODES, newId } from "./index.js";

describe("@scad/shared", () => {
  it("exports the package name and core APIs", () => {
    expect(PACKAGE_NAME).toBe("shared");
    expect(ERROR_CODES.length).toBeGreaterThan(0);
    expect(parseManifest({}).success).toBe(true);
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
