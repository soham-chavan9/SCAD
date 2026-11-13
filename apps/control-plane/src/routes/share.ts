import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { formatAppUrl, isUuid } from "@scad/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appAccess, apps, auditEvents, users } from "../db/schema.js";
import type { Mailer } from "../lifecycle/jobs.js";
import { ApiError, validationFailed } from "../errors.js";

export type ShareRoutesOpts = {
  db: Db["db"];
  /** For the link in the share email (T3.4). */
  baseDomain?: string;
  /** Emails the friend their link when they are newly shared with (T3.4). */
  mailer?: Mailer;
};

const emailSchema = z.string().trim().toLowerCase().email().max(254);

const shareBody = z.object({ email: emailSchema });

const patchAppBody = z
  .object({ visibility: z.enum(["allowlist", "instance", "public"]) })
  .strict();

function notFound(): ApiError {
  return new ApiError(
    404,
    "NOT_FOUND",
    "App not found",
    "No site of yours has that name. Check the name with list_apps (or `scad ls`) and try again.",
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
): Promise<{ id: string; slug: string; visibility: "allowlist" | "instance" | "public" }> {
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

/**
 * Tell a newly shared friend where the site is (T3.4). Best effort: the share
 * itself already happened, so a mail failure only means `emailed: false`.
 */
async function emailFriend(opts: ShareRoutesOpts, appId: string, email: string): Promise<boolean> {
  if (!opts.mailer || !opts.baseDomain) return false;
  const [row] = await opts.db
    .select({ slug: apps.slug, handle: users.handle, ownerEmail: users.email, ownerName: users.displayName })
    .from(apps)
    .innerJoin(users, eq(users.id, apps.ownerId))
    .where(eq(apps.id, appId))
    .limit(1);
  if (!row) return false;
  const url = formatAppUrl({ slug: row.slug, ownerHandle: row.handle, baseDomain: opts.baseDomain });
  const who = row.ownerName && row.ownerName !== row.ownerEmail ? `${row.ownerName} (${row.ownerEmail})` : row.ownerEmail;
  try {
    await opts.mailer.send({
      to: email,
      subject: `${who} shared a site with you`,
      text:
        `${who} shared "${row.slug}" with you:\n\n${url}\n\n` +
        `Open the link and sign in with this email address (${email}). ` +
        "You'll get a sign-in link by email; no password or account setup needed.\n",
    });
    return true;
  } catch {
    return false;
  }
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

      const added = await opts.db
        .insert(appAccess)
        .values({ appId: owned.id, email, grantedBy: request.user.id })
        .onConflictDoNothing()
        .returning({ email: appAccess.email });
      await opts.db.insert(auditEvents).values({
        actorId: request.user.id,
        appId: owned.id,
        action: "app.share",
        metadata: { email },
      });
      const emailed = added.length > 0 ? await emailFriend(opts, owned.id, email) : false;
      return reply.status(201).send({ app_id: owned.id, email, emailed });
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
      throw validationFailed("Only `visibility` can be changed (allowlist | instance | public)", {
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
