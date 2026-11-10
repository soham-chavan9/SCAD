import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { isHandle, isSlug, isUuid } from "@scad/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { apps, auditEvents, invites, sessions, users } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";
import { lockApp } from "../lifecycle/app-lock.js";
import { deleteApp } from "../lifecycle/delete.js";
import type { MachineController } from "../machines/controller.js";
import type { AuthUser } from "../plugins/auth.js";

/**
 * Operator controls (T2.6, AGENTS §8 /admin routes). Operators are users with
 * role=operator or an email in OPERATOR_EMAILS. Everyone else gets 403.
 * Every change writes an audit_events row.
 */
export type AdminRoutesOpts = {
  db: Db["db"];
  /** OPERATOR_EMAILS, lowercase. */
  operatorEmails: ReadonlySet<string>;
  /** Stops machines of suspended apps and users. */
  machines?: MachineController;
};

export function isOperator(
  user: Pick<AuthUser, "role" | "email">,
  operatorEmails: ReadonlySet<string>,
): boolean {
  return user.role === "operator" || operatorEmails.has(user.email.toLowerCase());
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);

function forbidden(): ApiError {
  return new ApiError(
    403,
    "FORBIDDEN",
    "Operator only",
    "Only operators (users listed in OPERATOR_EMAILS) may use admin commands.",
  );
}

function userNotFound(): ApiError {
  return new ApiError(
    404,
    "NOT_FOUND",
    "User not found",
    "Pass a user id or email from `scad admin users`.",
  );
}

function appNotFound(): ApiError {
  return new ApiError(
    404,
    "NOT_FOUND",
    "App not found",
    "Pass an app id or <owner-handle>/<slug> from `scad admin usage`.",
  );
}

function invalidEmail(): ApiError {
  return new ApiError(
    400,
    "VALIDATION_FAILED",
    "email must be a valid email address",
    "e.g. `scad admin invite add friend@example.com`.",
    { field: "email" },
  );
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOpts> = async (app, opts) => {
  const db = opts.db;

  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (!request.url.startsWith("/v1/admin/")) return;
    if (!isOperator(request.user, opts.operatorEmails)) throw forbidden();
  });

  async function audit(
    actorId: string,
    action: string,
    appId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(auditEvents).values({ actorId, appId, action, metadata });
  }

  /** A user by id or email. */
  async function findUser(ref: string) {
    const email = emailSchema.safeParse(ref);
    const where = isUuid(ref)
      ? eq(users.id, ref)
      : email.success
        ? eq(users.email, email.data)
        : null;
    if (!where) throw userNotFound();
    const [row] = await db.select().from(users).where(where).limit(1);
    if (!row) throw userNotFound();
    return row;
  }

  /** An app by id or `<owner-handle>/<slug>` (deleted apps are not found). */
  async function findApp(ref: string) {
    let where;
    if (isUuid(ref)) {
      where = eq(apps.id, ref);
    } else {
      const [handle, slug, extra] = ref.split("/");
      if (!handle || !slug || extra !== undefined || !isHandle(handle) || !isSlug(slug)) {
        throw appNotFound();
      }
      where = and(eq(users.handle, handle), eq(apps.slug, slug));
    }
    const [row] = await db
      .select({
        id: apps.id,
        slug: apps.slug,
        status: apps.status,
        ownerId: apps.ownerId,
        handle: users.handle,
      })
      .from(apps)
      .innerJoin(users, eq(apps.ownerId, users.id))
      .where(where)
      .limit(1);
    if (!row || row.status === "deleted") throw appNotFound();
    return row;
  }

  async function stopApps(appIds: string[]): Promise<void> {
    if (!opts.machines) return;
    for (const appId of appIds) {
      await opts.machines.stop(appId).catch((err: unknown) => {
        console.error(
          `stop after suspend failed for ${appId}:`,
          err instanceof Error ? err.message : "error",
        );
      });
    }
  }

  const userView = (u: typeof users.$inferSelect) => ({
    id: u.id,
    email: u.email,
    handle: u.handle,
    role: isOperator(u, opts.operatorEmails) ? "operator" : "member",
    status: u.status,
    created_at: u.createdAt.toISOString(),
  });

  app.get("/v1/admin/users", async () => {
    const rows = await db.select().from(users).orderBy(asc(users.email));
    return { users: rows.map(userView) };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/users/:id/suspend", async (request) => {
    const target = await findUser(request.params.id);
    if (target.id === request.user.id) {
      throw new ApiError(
        400,
        "VALIDATION_FAILED",
        "You cannot suspend yourself",
        "Ask another operator.",
      );
    }
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, target.id));
    // Sign them out everywhere; the gateway also checks status on every request.
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, target.id), isNull(sessions.revokedAt)));
    await audit(request.user.id, "user.suspend", null, { user_id: target.id, email: target.email });
    // Their apps are already refused at the gateway (owner not active); stop them too.
    const owned = await db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.ownerId, target.id), inArray(apps.status, ["running", "building"])));
    await stopApps(owned.map((a) => a.id));
    return { user: userView({ ...target, status: "suspended" }) };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/users/:id/unsuspend", async (request) => {
    const target = await findUser(request.params.id);
    await db.update(users).set({ status: "active" }).where(eq(users.id, target.id));
    await audit(request.user.id, "user.unsuspend", null, {
      user_id: target.id,
      email: target.email,
    });
    return { user: userView({ ...target, status: "active" }) };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/apps/:id/suspend", async (request) => {
    const found = await findApp(request.params.id);
    await db.transaction(async (tx) => {
      // Same lock as publish, delete, and build completion.
      await lockApp(tx, found.id);
      await tx.update(apps).set({ status: "suspended" }).where(eq(apps.id, found.id));
      await tx.insert(auditEvents).values({
        actorId: request.user.id,
        appId: found.id,
        action: "app.suspend",
        metadata: { previous_status: found.status },
      });
    });
    await stopApps([found.id]);
    return { app: { id: found.id, slug: found.slug, owner: found.handle, status: "suspended" } };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/apps/:id/unsuspend", async (request) => {
    const found = await findApp(request.params.id);
    if (found.status !== "suspended") {
      return { app: { id: found.id, slug: found.slug, owner: found.handle, status: found.status } };
    }
    // Stopped, not running: the next view wakes it (T1.4).
    await db
      .update(apps)
      .set({ status: "stopped" })
      .where(and(eq(apps.id, found.id), eq(apps.status, "suspended")));
    await audit(request.user.id, "app.unsuspend", found.id, {});
    return { app: { id: found.id, slug: found.slug, owner: found.handle, status: "stopped" } };
  });

  /**
   * Delete any app (T2.9 runbook: removing a user's data). Same as an owner
   * delete: container, network, /data volume, env, logs, and shares are
   * removed; the app row stays as `deleted` for the audit trail.
   */
  app.delete<{ Params: { id: string } }>("/v1/admin/apps/:id", async (request) => {
    const found = await findApp(request.params.id);
    if (!opts.machines) {
      throw new ApiError(
        503,
        "INTERNAL",
        "Deleting apps is not available on this instance",
        "Start the control plane with a runtime.",
      );
    }
    await deleteApp(db, opts.machines, found.id, { actorId: request.user.id, reason: "operator" });
    return { app: { id: found.id, slug: found.slug, owner: found.handle, status: "deleted" } };
  });

  app.get("/v1/admin/invites", async () => {
    const rows = await db
      .select({ email: invites.email, createdAt: invites.createdAt, invitedBy: users.email })
      .from(invites)
      .leftJoin(users, eq(invites.invitedBy, users.id))
      .orderBy(asc(invites.email));
    return {
      invites: rows.map((r) => ({
        email: r.email,
        invited_by: r.invitedBy ?? null,
        created_at: r.createdAt.toISOString(),
      })),
    };
  });

  app.post("/v1/admin/invites", async (request, reply) => {
    const body = z.object({ email: emailSchema }).safeParse(request.body);
    if (!body.success) throw invalidEmail();
    const [created] = await db
      .insert(invites)
      .values({ email: body.data.email, invitedBy: request.user.id })
      .onConflictDoNothing()
      .returning();
    if (created) await audit(request.user.id, "invite.add", null, { email: body.data.email });
    return reply.status(201).send({ email: body.data.email, created: Boolean(created) });
  });

  app.delete<{ Params: { email: string } }>("/v1/admin/invites/:email", async (request) => {
    const email = emailSchema.safeParse(request.params.email);
    if (!email.success) throw invalidEmail();
    const removed = await db.delete(invites).where(eq(invites.email, email.data)).returning();
    if (removed.length > 0)
      await audit(request.user.id, "invite.remove", null, { email: email.data });
    // Accounts that already exist are not touched: suspend the user to cut access.
    return { email: email.data, removed: removed.length > 0 };
  });

  app.get("/v1/admin/audit", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(50),
        app: z.string().max(100).optional(),
      })
      .safeParse(request.query);
    if (!query.success) throw validationFailed("limit must be between 1 and 500");
    const appId = query.data.app ? (await findApp(query.data.app)).id : null;
    const rows = await db
      .select({
        id: auditEvents.id,
        at: auditEvents.at,
        action: auditEvents.action,
        appId: auditEvents.appId,
        metadata: auditEvents.metadata,
        actor: users.email,
      })
      .from(auditEvents)
      .leftJoin(users, eq(auditEvents.actorId, users.id))
      .where(appId ? eq(auditEvents.appId, appId) : undefined)
      .orderBy(desc(auditEvents.at))
      .limit(query.data.limit);
    return {
      events: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        action: r.action,
        app_id: r.appId,
        actor: r.actor ?? null,
        metadata: r.metadata,
      })),
    };
  });
};
