import { and, desc, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { AppUrlError, formatAppUrl, isUuid, slugSchema } from "@scad/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { apps, auditEvents, users } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";

const createAppBody = z.object({
  slug: slugSchema,
});

export type AppsRoutesOpts = {
  db: Db["db"];
  baseDomain: string;
};

function appUrlOrThrow(opts: {
  slug: string;
  ownerHandle: string;
  baseDomain: string;
}): string {
  try {
    return formatAppUrl(opts);
  } catch (err) {
    if (err instanceof AppUrlError) {
      throw new ApiError(
        500,
        "INTERNAL",
        "Could not determine the app host URL",
        "Ensure BASE_DOMAIN is set and your account has a valid handle.",
        { reason: err.reason },
      );
    }
    throw err;
  }
}

export const appsRoutes: FastifyPluginAsync<AppsRoutesOpts> = async (app, opts) => {
  app.get("/v1/apps", async (request) => {
    const ownerId = request.user.id;
    const rows = await opts.db
      .select({
        id: apps.id,
        slug: apps.slug,
        ownerId: apps.ownerId,
        status: apps.status,
        visibility: apps.visibility,
        createdAt: apps.createdAt,
        expiresAt: apps.expiresAt,
        lastViewedAt: apps.lastViewedAt,
        ownerHandle: users.handle,
      })
      .from(apps)
      .innerJoin(users, eq(apps.ownerId, users.id))
      .where(and(eq(apps.ownerId, ownerId), ne(apps.status, "deleted")))
      .orderBy(desc(apps.createdAt));

    return {
      apps: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        ownerId: row.ownerId,
        status: row.status,
        visibility: row.visibility,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
        url: appUrlOrThrow({
          slug: row.slug,
          ownerHandle: row.ownerHandle,
          baseDomain: opts.baseDomain,
        }),
      })),
    };
  });

  app.get<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug", async (request) => {
    const ownerId = request.user.id;
    const { idOrSlug } = request.params;
    const byId = isUuid(idOrSlug);

    const rows = await opts.db
      .select({
        id: apps.id,
        slug: apps.slug,
        ownerId: apps.ownerId,
        status: apps.status,
        visibility: apps.visibility,
        createdAt: apps.createdAt,
        expiresAt: apps.expiresAt,
        lastViewedAt: apps.lastViewedAt,
        ownerHandle: users.handle,
      })
      .from(apps)
      .innerJoin(users, eq(apps.ownerId, users.id))
      .where(
        and(
          eq(apps.ownerId, ownerId),
          ne(apps.status, "deleted"),
          byId ? eq(apps.id, idOrSlug) : eq(apps.slug, idOrSlug),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        "App not found",
        "No site of yours has that name. Check the name with list_apps (or `scad ls`) and try again.",
      );
    }

    return {
      app: {
        id: row.id,
        slug: row.slug,
        ownerId: row.ownerId,
        status: row.status,
        visibility: row.visibility,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
        url: appUrlOrThrow({
          slug: row.slug,
          ownerHandle: row.ownerHandle,
          baseDomain: opts.baseDomain,
        }),
      },
    };
  });

  app.post("/v1/apps", async (request, reply) => {
    const parsed = createAppBody.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed("Invalid app create payload", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const { slug } = parsed.data;
    const ownerId = request.user.id;

    const [appRow] = await opts.db
      .insert(apps)
      .values({
        slug,
        ownerId,
        status: "stopped",
        visibility: "allowlist",
      })
      .returning();

    if (!appRow) {
      throw validationFailed("Failed to create app");
    }

    await opts.db.insert(auditEvents).values({
      actorId: ownerId,
      appId: appRow.id,
      action: "app.create",
      metadata: { slug },
    });

    return reply.status(201).send({
      app: {
        id: appRow.id,
        slug: appRow.slug,
        ownerId: appRow.ownerId,
        status: appRow.status,
        visibility: appRow.visibility,
        createdAt: appRow.createdAt.toISOString(),
      },
    });
  });
};
