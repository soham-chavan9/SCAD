import { eq } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import { isSharedEmail, normalizeEmail } from "./magic-links.js";

type Database = Db["db"];

/**
 * Invite allowlist (T2.6). Only these may create an account, by GitHub or
 * magic link: emails in OPERATOR_EMAILS, emails some app was shared to
 * (app_access), and emails on the operator's invite list. Existing accounts
 * are not affected (suspend a user to cut their access).
 */
export async function mayCreateAccount(
  db: Database,
  email: string,
  operatorEmails: ReadonlySet<string>,
): Promise<boolean> {
  const e = normalizeEmail(email);
  if (operatorEmails.has(e)) return true;
  if (await isSharedEmail(db, e)) return true;
  const rows = await db
    .select({ email: schema.invites.email })
    .from(schema.invites)
    .where(eq(schema.invites.email, e))
    .limit(1);
  return rows.length > 0;
}

/** Comma list (OPERATOR_EMAILS) to a lowercase set. */
export function parseEmailList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Thrown when someone who is not invited tries to create an account. No user row is written. */
export class NotInvitedError extends Error {
  constructor() {
    super("not invited");
    this.name = "NotInvitedError";
  }
}
