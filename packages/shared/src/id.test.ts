import { describe, expect, it } from "vitest";
import { isUuid, newId } from "./id.js";

describe("id helpers", () => {
  it("generates a uuid v4", () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(newId()).not.toBe(id);
  });

  it("rejects non-uuids", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("11111111-1111-1111-1111-111111111111")).toBe(false);
  });
});
