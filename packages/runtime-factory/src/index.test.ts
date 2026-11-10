import { describe, expect, it } from "vitest";
import { createRuntimeProvider, UnknownRuntimeError } from "./index.js";

describe("createRuntimeProvider", () => {
  it("defaults to the Docker driver, with its optional capabilities", () => {
    const runtime = createRuntimeProvider({});
    expect(typeof runtime.deploy).toBe("function");
    expect(typeof runtime.listApps).toBe("function");
    expect(typeof runtime.enforceVolumeQuota).toBe("function");
  });

  it("accepts an explicit docker", () => {
    expect(() => createRuntimeProvider({ SCAD_RUNTIME: "docker" })).not.toThrow();
  });

  it("refuses an unknown runtime instead of guessing", () => {
    expect(() => createRuntimeProvider({ SCAD_RUNTIME: "fly" })).toThrow(UnknownRuntimeError);
  });
});
