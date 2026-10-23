import { z } from "zod";

/** Structured API error codes (AGENTS §8). */
export const ERROR_CODES = [
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

export const errorEnvelopeSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  hint: z.string(),
  details: z.record(z.string(), z.unknown()),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function parseErrorEnvelope(value: unknown) {
  return errorEnvelopeSchema.safeParse(value);
}

export function makeError(
  code: ErrorCode,
  message: string,
  hint: string,
  details: Record<string, unknown> = {},
): ErrorEnvelope {
  return { code, message, hint, details };
}
