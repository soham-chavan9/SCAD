import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, registerRuntimeConformance } from "./index.js";

describe("@scad/runtime-conformance", () => {
  it("exports the package name and suite registrar", () => {
    expect(PACKAGE_NAME).toBe("runtime-conformance");
    expect(typeof registerRuntimeConformance).toBe("function");
  });
});
