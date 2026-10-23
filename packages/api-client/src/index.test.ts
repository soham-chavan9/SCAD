import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, ScadClient } from "./index.js";

describe("@scad/api-client", () => {
  it("exports the client", () => {
    expect(PACKAGE_NAME).toBe("api-client");
    expect(new ScadClient({ baseUrl: "http://example.com" })).toBeInstanceOf(ScadClient);
  });
});
