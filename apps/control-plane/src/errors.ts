import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { makeError, type ErrorCode, type ErrorEnvelope } from "@scad/shared";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly hint: string;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    hint: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  toEnvelope(): ErrorEnvelope {
    return makeError(this.code, this.message, this.hint, this.details);
  }
}

export function unauthenticated(message = "Missing or invalid credentials"): ApiError {
  return new ApiError(
    401,
    "UNAUTHENTICATED",
    message,
    "Provide Authorization: Bearer <PAT> from `scad login`.",
  );
}

export function validationFailed(message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(400, "VALIDATION_FAILED", message, "Fix the request body and retry.", details);
}

export function errorHandler(
  error: FastifyError | ApiError | Error,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof ApiError) {
    void reply.status(error.statusCode).send(error.toEnvelope());
    return;
  }

  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;

  if (statusCode === 400) {
    void reply.status(400).send(
      makeError("VALIDATION_FAILED", error.message, "Fix the request and retry."),
    );
    return;
  }

  void reply.status(500).send(
    makeError("INTERNAL", "Internal server error", "Retry later or contact an operator.", {}),
  );
}
