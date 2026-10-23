import { and, eq, gt, isNull } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import { randomToken, sha256 } from "../crypto.js";

type Database = Db["db"];

export const LOGIN_CODE_TTL_MS = 60_000;

export async function issueLoginCode(
  db: Database,
  opts: { userId: string; appHost: string; now?: Date },
): Promise<string> {
  const now = opts.now ?? new Date();
  const code = randomToken(24);
  await db.insert(schema.loginCodes).values({
    codeHash: sha256(code),
    userId: opts.userId,
    appHost: opts.appHost.toLowerCase(),
    expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MS),
  });
  return code;
}

export type ConsumedLoginCode = {
  userId: string;
  appHost: string;
};

/** Consume a one-time login code. Fails if missing, expired, wrong host, or already used (INV5). */
export async function consumeLoginCode(
  db: Database,
  opts: { code: string; appHost: string; now?: Date },
): Promise<ConsumedLoginCode> {
  const now = opts.now ?? new Date();
  const codeHash = sha256(opts.code);
  const appHost = opts.appHost.toLowerCase();

  const rows = await db
    .select()
    .from(schema.loginCodes)
    .where(eq(schema.loginCodes.codeHash, codeHash))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new LoginCodeError("invalid");
  }
  if (row.usedAt) {
    throw new LoginCodeError("reused");
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new LoginCodeError("expired");
  }
  if (row.appHost !== appHost) {
    throw new LoginCodeError("host_mismatch");
  }

  const updated = await db
    .update(schema.loginCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.loginCodes.codeHash, codeHash),
        isNull(schema.loginCodes.usedAt),
        gt(schema.loginCodes.expiresAt, now),
      ),
    )
    .returning();

  if (!updated[0]) {
    throw new LoginCodeError("reused");
  }

  return { userId: row.userId, appHost: row.appHost };
}

export class LoginCodeError extends Error {
  readonly reason: "invalid" | "reused" | "expired" | "host_mismatch";

  constructor(reason: LoginCodeError["reason"]) {
    super(`login code ${reason}`);
    this.name = "LoginCodeError";
    this.reason = reason;
  }
}
