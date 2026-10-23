import { z } from "zod";

/** App slug: `[a-z0-9-]{3,40}` (AGENTS §11). */
export const SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;

/**
 * Owner handle derived from GitHub login: lowercase alphanumeric with internal hyphens,
 * 1–39 characters (GitHub username bounds).
 */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export const slugSchema = z
  .string()
  .regex(SLUG_PATTERN, "slug must match [a-z0-9-]{3,40}");

export const handleSchema = z
  .string()
  .regex(
    HANDLE_PATTERN,
    "handle must be 1–39 lowercase letters, digits, or internal hyphens",
  );

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function isHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}

export function parseSlug(value: unknown) {
  return slugSchema.safeParse(value);
}

export function parseHandle(value: unknown) {
  return handleSchema.safeParse(value);
}
