import { describe, expect, it } from "vitest";
import { isHandle, isSlug, parseHandle, parseSlug } from "./validators.js";

/** INV11: bad slug/handle rejected (uppercase, .., /, space, over-length, shell chars, unicode lookalike). */
const BAD_SLUGS = [
  "Hello", // uppercase
  "..", // traversal
  "../x",
  "ab/cd", // slash
  "has space",
  "a".repeat(41), // over-length
  "ab", // under-length
  "evil;rm", // shell chars
  "x$(id)",
  "аbc", // cyrillic lookalike 'а'
  "café",
];

const BAD_HANDLES = [
  "Alice", // uppercase
  "..",
  "a/b",
  "has space",
  "a".repeat(40), // over GitHub-style max
  "-leading",
  "trailing-",
  "evil;rm",
  "x`id`",
  "аlice", // cyrillic lookalike
];

describe("slug validator", () => {
  it("accepts valid slugs", () => {
    expect(isSlug("abc")).toBe(true);
    expect(isSlug("sprint-tracker")).toBe(true);
    expect(isSlug("a".repeat(40))).toBe(true);
  });

  it("rejects bad slugs (INV11)", () => {
    for (const bad of BAD_SLUGS) {
      expect(isSlug(bad), `slug should reject ${JSON.stringify(bad)}`).toBe(false);
      expect(parseSlug(bad).success).toBe(false);
    }
  });
});

describe("handle validator", () => {
  it("accepts valid handles", () => {
    expect(isHandle("alice")).toBe(true);
    expect(isHandle("alice-dev")).toBe(true);
  });

  it("rejects bad handles (INV11)", () => {
    for (const bad of BAD_HANDLES) {
      expect(isHandle(bad), `handle should reject ${JSON.stringify(bad)}`).toBe(false);
      expect(parseHandle(bad).success).toBe(false);
    }
  });
});
