import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { applyManifestDefaults, isHandle, isSlug, type ManifestInput } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, releases, users } from "../db/schema.js";
import { ApiError, unauthenticated, validationFailed } from "../errors.js";

const resolveBody = z.object({
  host: z.string().min(1),
});

export type InternalRoutesOpts = {
  db: Db["db"];
  internalSecret: string;
  baseDomain: string;
};

function parseAppHost(
  host: string,
  baseDomain: string,
): { slug: string; ownerHandle: string } | null {
  const authHost = `auth.${baseDomain}`;
  if (host === authHost || host === baseDomain) {
    return null;
  }
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) {
    return null;
  }
  const prefix = host.slice(0, -suffix.length);
  const parts = prefix.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [slug, ownerHandle] = parts;
  if (!slug || !ownerHandle) {
    return null;
  }
  // INV11: reject uppercase, path chars, over-length, etc. before DB lookup.
  if (!isSlug(slug) || !isHandle(ownerHandle)) {
    return null;
  }
  return { slug, ownerHandle };
}

function portFromManifest(manifest: unknown): number {
  return applyManifestDefaults((manifest ?? {}) as ManifestInput).port;
}

export const internalRoutes: FastifyPluginAsync<InternalRoutesOpts> = async (app, opts) => {
  app.addHook("preHandler", async (request) => {
    const config = request.routeOptions.config;
    if (!config.internal) {
      return;
    }
    const secret = request.headers["x-scad-internal-secret"];
    if (typeof secret !== "string" || secret.length === 0 || secret !== opts.internalSecret) {
      throw unauthenticated("Invalid internal secret");
    }
  });

  app.post(
    "/internal/resolve",
    { config: { internal: true } },
    async (request) => {
      const parsed = resolveBody.safeParse(request.body);
      if (!parsed.success) {
        throw validationFailed("host is required");
      }

      const parsedHost = parseAppHost(parsed.data.host, opts.baseDomain);
      if (!parsedHost) {
        throw new ApiError(404, "NOT_FOUND", "Unknown host", "Check the app URL.", {});
      }

      const rows = await opts.db
        .select({
          appId: apps.id,
          slug: apps.slug,
          status: apps.status,
          expiresAt: apps.expiresAt,
          ownerId: users.id,
          ownerHandle: users.handle,
          ownerEmail: users.email,
          ownerStatus: users.status,
        })
        .from(apps)
        .innerJoin(users, eq(apps.ownerId, users.id))
        .where(
          and(
            eq(apps.slug, parsedHost.slug),
            eq(users.handle, parsedHost.ownerHandle),
            ne(apps.status, "deleted"),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw new ApiError(404, "NOT_FOUND", "Unknown app", "Check the app URL.", {});
      }

      const ready = await opts.db
        .select({ manifest: releases.manifest })
        .from(releases)
        .where(and(eq(releases.appId, row.appId), eq(releases.status, "ready")))
        .orderBy(desc(releases.version))
        .limit(1);

      const port = portFromManifest(ready[0]?.manifest);

      return {
        appId: row.appId,
        slug: row.slug,
        status: row.status,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        ownerId: row.ownerId,
        ownerHandle: row.ownerHandle,
        ownerEmail: row.ownerEmail,
        ownerStatus: row.ownerStatus,
        // Convention matches packages/runtime-docker containerName()
        upstreamHost: `scad-run-${row.appId}`,
        port,
      };
    },
  );
};

export { parseAppHost, portFromManifest };
