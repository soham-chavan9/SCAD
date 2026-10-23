import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, Builder } from "./index.js";

describe("@scad/builder", () => {
  it("exports the builder", () => {
    expect(PACKAGE_NAME).toBe("builder");
    expect(
      new Builder({
        controlPlaneUrl: "http://127.0.0.1:4000",
        internalToken: "x",
      }),
    ).toBeInstanceOf(Builder);
  });
});
