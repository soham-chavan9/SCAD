import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@scad/runtime-conformance", () => {
  it("exports the placeholder", () => {
    expect(PACKAGE_NAME).toBe("runtime-conformance");
  });
});
