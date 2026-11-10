import { z } from "zod";
import { slugSchema } from "./validators.js";

/** Defaults and caps from AGENTS §11. */
export const MANIFEST_DEFAULTS = {
  port: 8080,
  resources: {
    memory_mb: 512,
    disk_gb: 1,
  },
  frame_ancestors: "self",
} as const;

export const MANIFEST_CAPS = {
  memory_mb: 1024,
  disk_gb: 5,
} as const;

const portSchema = z
  .number()
  .int("port must be an integer")
  .min(1, "port must be between 1 and 65535")
  .max(65535, "port must be between 1 and 65535");

/** POSIX-style variable names; keeps `KEY=value` unambiguous in the container env. */
const envKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "env keys must match [A-Za-z_][A-Za-z0-9_]* (max 128 chars)");

/** Suffixes that only name private or local things; never valid egress targets. */
const PRIVATE_TLDS = new Set(["internal", "local", "localhost", "arpa", "home", "lan", "corp", "intranet"]);

/**
 * An egress domain: a lowercase public hostname, optionally `*.` for its
 * subdomains (T2.1). IP literals, ports, schemes, and private names are refused.
 */
export const egressDomainSchema = z
  .string()
  .max(253)
  .refine((value) => {
    const host = value.startsWith("*.") ? value.slice(2) : value;
    const labels = host.split(".");
    if (labels.length < 2) return false;
    if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
    const tld = labels[labels.length - 1] ?? "";
    return /^[a-z]{2,63}$/.test(tld) && !PRIVATE_TLDS.has(tld);
  }, "egress entries must be lowercase public hostnames like api.github.com or *.googleapis.com (no IPs, ports, or schemes)");

export const manifestSchema = z
  .object({
    name: slugSchema.optional(),
    port: portSchema.optional(),
    start: z.string().min(1).optional(),
    env: z.record(envKeySchema, z.string().max(32_768, "env values are limited to 32 KB")).optional(),
    egress: z.array(egressDomainSchema).max(50, "at most 50 egress domains").optional(),
    resources: z
      .object({
        memory_mb: z
          .number()
          .int()
          .positive()
          .max(MANIFEST_CAPS.memory_mb, `memory_mb cap is ${MANIFEST_CAPS.memory_mb}`)
          .optional(),
        disk_gb: z
          .number()
          .int()
          .positive()
          .max(MANIFEST_CAPS.disk_gb, `disk_gb cap is ${MANIFEST_CAPS.disk_gb}`)
          .optional(),
      })
      .optional(),
    frame_ancestors: z.string().min(1).optional(),
  })
  .strict();

export type ManifestInput = z.infer<typeof manifestSchema>;

export type ResolvedManifest = {
  name?: string;
  port: number;
  start?: string;
  env: Record<string, string>;
  egress: string[];
  resources: {
    memory_mb: number;
    disk_gb: number;
  };
  frame_ancestors: string;
};

export function parseManifest(value: unknown) {
  return manifestSchema.safeParse(value);
}

export type ManifestIssue = { path: string; message: string };

/**
 * Field-level description of a manifest validation error, for §8
 * `MANIFEST_INVALID`: `issues` goes in `details`, `hint` names the first field.
 */
export function describeManifestIssues(error: z.ZodError): { issues: ManifestIssue[]; hint: string } {
  const issues = error.issues.map((issue) => {
    const keys = "keys" in issue && Array.isArray(issue.keys) ? (issue.keys as string[]) : [];
    const path = [...issue.path.map(String), ...(keys.length === 1 ? keys : [])].join(".");
    const message =
      issue.code === "unrecognized_keys"
        ? `unknown field${keys.length > 1 ? "s" : ""} ${keys.map((k) => `"${k}"`).join(", ")}`
        : issue.message;
    return { path, message };
  });
  const first = issues[0];
  const where = first?.path ? `"${first.path}"` : "the top level";
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more, see details.issues)` : "";
  const hint = first
    ? `Fix ${where} in scad.json: ${first.message}${more}. See AGENTS §11 for fields, defaults, and caps.`
    : "Fix scad.json and republish.";
  return { issues, hint };
}

/** Merge a parsed (or empty) manifest with §11 defaults. */
export function applyManifestDefaults(input: ManifestInput = {}): ResolvedManifest {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    port: input.port ?? MANIFEST_DEFAULTS.port,
    ...(input.start !== undefined ? { start: input.start } : {}),
    env: input.env ?? {},
    egress: input.egress ?? [],
    resources: {
      memory_mb: input.resources?.memory_mb ?? MANIFEST_DEFAULTS.resources.memory_mb,
      disk_gb: input.resources?.disk_gb ?? MANIFEST_DEFAULTS.resources.disk_gb,
    },
    frame_ancestors: input.frame_ancestors ?? MANIFEST_DEFAULTS.frame_ancestors,
  };
}
