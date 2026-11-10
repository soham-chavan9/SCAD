import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { isUuid } from "@scad/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appAccess, apps, auditEvents } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";

export type ShareRoutesOpts = {
  db: Db["db"];
};

const emailSchema = z.string().trim().toLowerCase().email().max(254);

const shareBody = z.object({ email: emailSchema });

const patchAppBody = z
  .object({ visibility: z.enum(["allowlist", "instance"]) })
  .strict();

function notFound(): ApiError {
  return new ApiError(
    404,
    "NOT_FOUND",
    "App not found",
    "Pass a slug or app id you own (from `scad ls` or GET /v1/apps).",
  );
}

/**
 * Load an app the caller owns, by id or slug. Apps owned by someone else are
 * reported as NOT_FOUND so ownership is never leaked (INV10).
 */
export async function findOwnedApp(
  db: Db["db"],
  ownerId: string,
  idOrSlug: string,
): Promise<{ id: string; slug: string; visibility: "allowlist" | "instance" }> {
  const rows = await db
    .select({ id: apps.id, slug: apps.slug, visibility: apps.visibility })
    .from(apps)
    .where(
      and(
        eq(apps.ownerId, ownerId),
        ne(apps.status, "deleted"),
        isUuid(idOrSlug) ? eq(apps.id, idOrSlug) : eq(apps.slug, idOrSlug),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

function parseEmail(raw: unknown): string {
  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "VALIDATION_FAILED",
      "email must be a valid email address",
      "Pass the viewer's email, e.g. `scad share my-app friend@example.com`.",
      { field: "email" },
    );
  }
  return parsed.data;
}

export const shareRoutes: FastifyPluginAsync<ShareRoutesOpts> = async (app, opts) => {
  app.get<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug/share", async (request) => {
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    const rows = await opts.db
      .select({ email: appAccess.email, createdAt: appAccess.createdAt })
      .from(appAccess)
      .where(eq(appAccess.appId, owned.id))
      .orderBy(asc(appAccess.email));
    return {
      app_id: owned.id,
      visibility: owned.visibility,
      viewers: rows.map((r) => ({ email: r.email, granted_at: r.createdAt.toISOString() })),
    };
  });

  app.post<{ Params: { idOrSlug: string } }>(
    "/v1/apps/:idOrSlug/share",
    async (request, reply) => {
      const parsed = shareBody.safeParse(request.body);
      const email = parseEmail(parsed.success ? parsed.data.email : undefined);
      const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);

      await opts.db
        .insert(appAccess)
        .values({ appId: owned.id, email, grantedBy: request.user.id })
        .onConflictDoNothing();
      await opts.db.insert(auditEvents).values({
        actorId: request.user.id,
        appId: owned.id,
        action: "app.share",
        metadata: { email },
      });
      return reply.status(201).send({ app_id: owned.id, email });
    },
  );

  app.delete<{ Params: { idOrSlug: string; email: string } }>(
    "/v1/apps/:idOrSlug/share/:email",
    async (request) => {
      const email = parseEmail(request.params.email);
      const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
      const removed = await opts.db
        .delete(appAccess)
        .where(and(eq(appAccess.appId, owned.id), eq(appAccess.email, email)))
        .returning();
      await opts.db.insert(auditEvents).values({
        actorId: request.user.id,
        appId: owned.id,
        action: "app.unshare",
        metadata: { email, removed: removed.length > 0 },
      });
      return { app_id: owned.id, email, removed: removed.length > 0 };
    },
  );

  app.patch<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug", async (request) => {
    const parsed = patchAppBody.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed("Only `visibility` can be changed (allowlist | instance)", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    const [updated] = await opts.db
      .update(apps)
      .set({ visibility: parsed.data.visibility })
      .where(eq(apps.id, owned.id))
      .returning({ id: apps.id, slug: apps.slug, visibility: apps.visibility });
    await opts.db.insert(auditEvents).values({
      actorId: request.user.id,
      appId: owned.id,
      action: "app.visibility",
      metadata: { from: owned.visibility, to: parsed.data.visibility },
    });
    return { app: updated };
  });
};
