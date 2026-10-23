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

export const manifestSchema = z
  .object({
    name: slugSchema.optional(),
    port: portSchema.optional(),
    start: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    egress: z.array(z.string().min(1)).optional(),
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
