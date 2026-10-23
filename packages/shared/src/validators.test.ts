import { describe, expect, it } from "vitest";
import { isHandle, isSlug, parseHandle, parseSlug } from "./validators.js";

describe("slug validator", () => {
  it("accepts valid slugs", () => {
    expect(isSlug("abc")).toBe(true);
    expect(isSlug("sprint-tracker")).toBe(true);
    expect(isSlug("a".repeat(40))).toBe(true);
  });

  it("rejects bad slugs", () => {
    expect(isSlug("ab")).toBe(false);
    expect(isSlug("A-B")).toBe(false);
    expect(isSlug("has_underscore")).toBe(false);
    expect(isSlug("a".repeat(41))).toBe(false);
    expect(parseSlug("Bad!").success).toBe(false);
  });
});

describe("handle validator", () => {
  it("accepts valid handles", () => {
    expect(isHandle("alice")).toBe(true);
    expect(isHandle("alice-dev")).toBe(true);
  });

  it("rejects bad handles", () => {
    expect(isHandle("")).toBe(false);
    expect(isHandle("Alice")).toBe(false);
    expect(isHandle("-alice")).toBe(false);
    expect(isHandle("alice-")).toBe(false);
    expect(parseHandle("no spaces").success).toBe(false);
  });
});
