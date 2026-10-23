import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@scad/gateway", () => {
  it("exports the placeholder", () => {
    expect(PACKAGE_NAME).toBe("gateway");
  });
});
