import { describe, expect, it } from "vitest";
import { isHandle, isSlug, parseHandle, parseSlug } from "./validators.js";

describe("slug validator", () => {
  it("accepts valid slugs", () => {
    expect(isSlug("abc")).toBe(true);
    expect(isSlug("sprint-tracker")).toBe(true);
    expect(isSlug("a".repeat(40))).toBe(true);
  });

  it("rejects bad slugs (INV11)", () => {
    expect(isSlug("ab")).toBe(false);
    expect(isSlug("A-B")).toBe(false);
    expect(isSlug("has_underscore")).toBe(false);
    expect(isSlug("a".repeat(41))).toBe(false);
    expect(isSlug("has space")).toBe(false);
    expect(isSlug("../etc")).toBe(false);
    expect(isSlug("a/b")).toBe(false);
    expect(isSlug("foo;rm")).toBe(false);
    expect(isSlug("foo$(id)")).toBe(false);
    expect(isSlug("foo`id`")).toBe(false);
    // Cyrillic lookalike 'а' (U+0430) instead of Latin 'a'
    expect(isSlug("аbc")).toBe(false);
    expect(parseSlug("Bad!").success).toBe(false);
  });
});

describe("handle validator", () => {
  it("accepts valid handles", () => {
    expect(isHandle("alice")).toBe(true);
    expect(isHandle("alice-dev")).toBe(true);
  });

  it("rejects bad handles (INV11)", () => {
    expect(isHandle("")).toBe(false);
    expect(isHandle("Alice")).toBe(false);
    expect(isHandle("-alice")).toBe(false);
    expect(isHandle("alice-")).toBe(false);
    expect(isHandle("no spaces")).toBe(false);
    expect(isHandle("../x")).toBe(false);
    expect(isHandle("a/b")).toBe(false);
    expect(isHandle("a;b")).toBe(false);
    expect(isHandle("a".repeat(40))).toBe(false);
    expect(isHandle("аlice")).toBe(false); // unicode lookalike
    expect(parseHandle("no spaces").success).toBe(false);
  });
});
