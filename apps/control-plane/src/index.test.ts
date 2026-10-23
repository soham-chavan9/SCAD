import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@scad/control-plane", () => {
  it("exports the placeholder", () => {
    expect(PACKAGE_NAME).toBe("control-plane");
  });
});
