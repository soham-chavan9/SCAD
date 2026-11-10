import type { AdminAppRef, AdminUser, AuditEvent, Invite, UsageReport } from "@scad/api-client";
import { client, type ClientOptions } from "./share.js";

/** `scad admin ...` (T2.6). Operators only; the control plane answers 403 to anyone else. */

export async function adminUsers(opts: ClientOptions): Promise<AdminUser[]> {
  return (await (await client(opts)).adminListUsers()).users;
}

export async function adminSuspendUser(
  opts: ClientOptions & { user: string; suspended: boolean },
): Promise<AdminUser> {
  return (await (await client(opts)).adminSetUserSuspended(opts.user, opts.suspended)).user;
}

export async function adminSuspendApp(
  opts: ClientOptions & { app: string; suspended: boolean },
): Promise<AdminAppRef> {
  return (await (await client(opts)).adminSetAppSuspended(opts.app, opts.suspended)).app;
}

export async function adminInvites(opts: ClientOptions): Promise<Invite[]> {
  return (await (await client(opts)).adminListInvites()).invites;
}

export async function adminInviteAdd(
  opts: ClientOptions & { email: string },
): Promise<{ email: string; created: boolean }> {
  return (await client(opts)).adminAddInvite(opts.email);
}

export async function adminInviteRemove(
  opts: ClientOptions & { email: string },
): Promise<{ email: string; removed: boolean }> {
  return (await client(opts)).adminRemoveInvite(opts.email);
}

export async function adminAudit(
  opts: ClientOptions & { limit?: number; app?: string },
): Promise<AuditEvent[]> {
  return (
    await (
      await client(opts)
    ).adminAudit({
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.app ? { app: opts.app } : {}),
    })
  ).events;
}

/** `scad admin usage` (T2.7). */
export async function adminUsage(opts: ClientOptions & { days?: number }): Promise<UsageReport> {
  return (await client(opts)).adminUsage(opts.days);
}

function fmtBytes(n: number | null): string {
  if (n === null) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** Plain-text table for the terminal. */
export function formatUsage(report: UsageReport): string {
  const header = ["APP", "STATUS", "REQUESTS", "VIEWERS", "LAST VIEWED", "RUN HOURS", "VOLUME"];
  const rows = report.apps.map((a) => [
    `${a.owner}/${a.slug}`,
    a.pinned ? `${a.status} (pinned)` : a.status,
    String(a.requests),
    String(a.unique_viewers),
    a.last_viewed_at ? a.last_viewed_at.slice(0, 16).replace("T", " ") : "-",
    a.running_hours.toFixed(2),
    fmtBytes(a.volume_bytes),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const t = report.totals;
  return [
    line(header),
    ...rows.map(line),
    "",
    `${t.apps} apps (${t.running} running), ${t.requests} requests in ${report.window_days} days, ` +
      `${t.running_hours.toFixed(2)} running hours, ${fmtBytes(t.volume_bytes)} on volumes`,
  ].join("\n");
}
