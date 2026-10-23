import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@scad/e2e", () => {
  it("exports the placeholder", () => {
    expect(PACKAGE_NAME).toBe("e2e");
  });
});
