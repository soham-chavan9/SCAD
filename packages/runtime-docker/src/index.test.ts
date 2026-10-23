import { describe, expect, it } from "vitest";
import { DockerRuntimeProvider, PACKAGE_NAME } from "./index.js";

describe("@scad/runtime-docker", () => {
  it("exports the package name and provider", () => {
    expect(PACKAGE_NAME).toBe("runtime-docker");
    expect(new DockerRuntimeProvider()).toBeInstanceOf(DockerRuntimeProvider);
  });
});
