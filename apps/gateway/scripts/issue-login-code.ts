/**
 * Browserless helper: issue a one-time login code for smoke tests.
 * Usage (from repo root):
 *   pnpm --filter @scad/gateway exec tsx scripts/issue-login-code.ts --email E --app-host H [--expire]
 * Prints only the plaintext code.
 */
import { eq } from "drizzle-orm";
import { createDb, schema } from "@scad/control-plane";
import { issueLoginCode, LOGIN_CODE_TTL_MS } from "../src/auth/login-codes.js";
import { sha256 } from "../src/crypto.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const email = (arg("--email") ?? "").toLowerCase();
  const appHost = (arg("--app-host") ?? "").toLowerCase();
  const expire = process.argv.includes("--expire");
  if (!email || !appHost) {
    process.stderr.write("usage: --email EMAIL --app-host HOST [--expire]\n");
    process.exit(2);
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    process.stderr.write("DATABASE_URL required\n");
    process.exit(2);
  }

  const { db, client } = createDb(databaseUrl);
  try {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (!user) {
      process.stderr.write("user not found\n");
      process.exit(1);
    }

    const code = await issueLoginCode(db, { userId: user.id, appHost });
    if (expire) {
      const past = new Date(Date.now() - LOGIN_CODE_TTL_MS - 1000);
      await db
        .update(schema.loginCodes)
        .set({ expiresAt: past })
        .where(eq(schema.loginCodes.codeHash, sha256(code)));
    }
    process.stdout.write(`${code}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
