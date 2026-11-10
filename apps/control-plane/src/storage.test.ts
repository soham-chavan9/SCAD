import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataPaths } from "./storage.js";

describe("data paths (T2.9)", () => {
  it("are absolute even when SCAD_DATA_DIR is relative, so the builder can open them from its own cwd", () => {
    const paths = createDataPaths("./.scad-data");
    expect(isAbsolute(paths.root)).toBe(true);
    expect(paths.root).toBe(join(process.cwd(), ".scad-data"));
    expect(isAbsolute(paths.tarballPath("r1"))).toBe(true);
    expect(paths.tarballPath("r1")).toBe(join(process.cwd(), ".scad-data", "tarballs", "r1.tar"));
  });
});
