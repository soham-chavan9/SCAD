import type { AdminAppRef, AdminUser, AuditEvent, Invite } from "@scad/api-client";
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
