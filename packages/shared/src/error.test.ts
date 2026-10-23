import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  errorEnvelopeSchema,
  parseErrorEnvelope,
  type ErrorCode,
} from "./error.js";

describe("error envelope", () => {
  it("lists every §8 error code", () => {
    const expected: ErrorCode[] = [
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "VALIDATION_FAILED",
      "MANIFEST_INVALID",
      "UPLOAD_TOO_LARGE",
      "LIMIT_EXCEEDED",
      "BUILD_FAILED",
      "PORT_NOT_LISTENING",
      "SMOKE_CHECK_FAILED",
      "APP_SUSPENDED",
      "APP_EXPIRED",
      "RATE_LIMITED",
      "INTERNAL",
    ];
    expect([...ERROR_CODES].sort()).toEqual([...expected].sort());
  });

  it("accepts a well-shaped envelope", () => {
    const envelope = {
      code: "BUILD_FAILED" as const,
      message: "docker build failed",
      hint: "Fix the Dockerfile and republish",
      details: { log_tail: ["step 1", "error"] },
    };
    const result = parseErrorEnvelope(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(envelope);
    }
  });

  it("requires code, message, hint, and details", () => {
    expect(parseErrorEnvelope({ code: "INTERNAL" }).success).toBe(false);
    expect(
      parseErrorEnvelope({
        code: "NOT_FOUND",
        message: "missing",
        hint: "check the id",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown codes", () => {
    expect(
      parseErrorEnvelope({
        code: "WAT",
        message: "nope",
        hint: "nope",
        details: {},
      }).success,
    ).toBe(false);
  });

  it("matches the schema export", () => {
    expect(errorEnvelopeSchema.safeParse({}).success).toBe(false);
  });
});
