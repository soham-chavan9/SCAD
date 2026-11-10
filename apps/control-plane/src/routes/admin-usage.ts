import { asc, eq, gte, ne, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { apps, machines, usageViewers, users } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";
import { utcDay } from "../lifecycle/policy.js";
import { currentRunSeconds } from "../machines/running-time.js";
import { isOperator } from "./admin.js";
import { OPERATOR_PAGE_CSP, operatorPageHtml } from "./operator-page.js";

export type AdminUsageOpts = {
  db: Db["db"];
  operatorEmails: ReadonlySet<string>;
  now?: () => Date;
};

export type AppUsage = {
  id: string;
  owner: string;
  slug: string;
  status: string;
  pinned: boolean;
  requests: number;
  unique_viewers: number;
  last_viewed_at: string | null;
  running_hours: number;
  volume_bytes: number | null;
  volume_measured_at: string | null;
  expires_at: string | null;
};

const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(35).default(30) });

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Usage and cost visibility (T2.7): `GET /v1/admin/usage` and the operator
 * page at `GET /admin`. Requests and unique viewers come from the raw
 * per-viewer counters (kept 35 days), so they are current, not only as of the
 * last hourly roll-up. Running hours are all-time; volume size is the last
 * measurement by the 5-minute quota sweep (running apps only).
 */
export const adminUsageRoutes: FastifyPluginAsync<AdminUsageOpts> = async (app, opts) => {
  const now = opts.now ?? (() => new Date());

  app.get("/v1/admin/usage", async (request) => {
    if (!isOperator(request.user, opts.operatorEmails)) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Operator only",
        "Only operators (users listed in OPERATOR_EMAILS) may see usage.",
      );
    }
    const query = usageQuery.safeParse(request.query);
    if (!query.success) throw validationFailed("days must be between 1 and 35");
    const at = now();
    const since = utcDay(new Date(at.getTime() - (query.data.days - 1) * 86_400_000));

    const traffic = opts.db
      .select({
        appId: usageViewers.appId,
        requests: sql<number>`sum(${usageViewers.requests})::int`.as("requests"),
        viewers: sql<number>`count(distinct ${usageViewers.userId})::int`.as("viewers"),
      })
      .from(usageViewers)
      .where(gte(usageViewers.day, since))
      .groupBy(usageViewers.appId)
      .as("traffic");

    const rows = await opts.db
      .select({
        id: apps.id,
        owner: users.handle,
        slug: apps.slug,
        status: apps.status,
        pinned: apps.pinned,
        lastViewedAt: apps.lastViewedAt,
        expiresAt: apps.expiresAt,
        requests: sql<number>`coalesce(${traffic.requests}, 0)`,
        viewers: sql<number>`coalesce(${traffic.viewers}, 0)`,
        runningSeconds: sql<number>`coalesce(${machines.runningSeconds} + ${currentRunSeconds(at)}, 0)::bigint`,
        volumeBytes: machines.volumeBytes,
        volumeMeasuredAt: machines.volumeMeasuredAt,
      })
      .from(apps)
      .innerJoin(users, eq(apps.ownerId, users.id))
      .leftJoin(machines, eq(machines.appId, apps.id))
      .leftJoin(traffic, eq(traffic.appId, apps.id))
      .where(ne(apps.status, "deleted"))
      .orderBy(asc(users.handle), asc(apps.slug));

    const list: AppUsage[] = rows.map((r) => ({
      id: r.id,
      owner: r.owner,
      slug: r.slug,
      status: r.status,
      pinned: r.pinned,
      requests: Number(r.requests),
      unique_viewers: Number(r.viewers),
      last_viewed_at: r.lastViewedAt?.toISOString() ?? null,
      running_hours: round2(Number(r.runningSeconds) / 3600),
      volume_bytes: r.volumeBytes ?? null,
      volume_measured_at: r.volumeMeasuredAt?.toISOString() ?? null,
      expires_at: r.expiresAt?.toISOString() ?? null,
    }));
    return {
      window_days: query.data.days,
      since,
      generated_at: at.toISOString(),
      apps: list,
      totals: {
        apps: list.length,
        running: list.filter((a) => a.status === "running").length,
        requests: list.reduce((n, a) => n + a.requests, 0),
        running_hours: round2(list.reduce((n, a) => n + a.running_hours, 0)),
        volume_bytes: list.reduce((n, a) => n + (a.volume_bytes ?? 0), 0),
      },
    };
  });

  // The page holds no data: its script asks for a PAT, keeps it in this tab
  // only (sessionStorage), and calls /v1/admin/usage with it.
  app.get("/admin", { config: { public: true } }, async (_request, reply) => {
    return reply
      .header("content-security-policy", OPERATOR_PAGE_CSP)
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY")
      .type("text/html; charset=utf-8")
      .send(operatorPageHtml());
  });
};
