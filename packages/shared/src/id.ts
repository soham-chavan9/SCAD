import { randomUUID } from "node:crypto";
import { z } from "zod";

/** UUID v4 (RFC 4122 version + variant bits). */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidSchema = z.string().regex(UUID_V4, "must be a UUID v4");

export function newId(): string {
  return randomUUID();
}

export function isUuid(value: string): boolean {
  return UUID_V4.test(value);
}
