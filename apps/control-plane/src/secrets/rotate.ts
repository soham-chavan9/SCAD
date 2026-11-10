import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client.js";
import { envVars } from "../db/schema.js";
import { parseMasterKey, rewrapEnvValue, type MasterKeyRing } from "./crypto.js";

/**
 * Rewrap every env var's data key under `keys.current` (MASTER_KEY rotation,
 * see docs/secrets.md). Values are never decrypted to disk or logged; each row
 * is rewrapped in memory and updated in one transaction.
 */
export async function rotateMasterKey(opts: { db: Db["db"]; keys: MasterKeyRing }): Promise<{ rewrapped: number }> {
  return opts.db.transaction(async (tx) => {
    const rows = await tx.select().from(envVars);
    for (const row of rows) {
      const ctx = { appId: row.appId, key: row.key };
      const valueCiphertext = rewrapEnvValue(opts.keys, ctx, row.valueCiphertext);
      await tx
        .update(envVars)
        .set({ valueCiphertext })
        .where(and(eq(envVars.appId, row.appId), eq(envVars.key, row.key)));
    }
    return { rewrapped: rows.length };
  });
}

/** Parse MASTER_KEY and the optional comma-separated MASTER_KEY_PREVIOUS. */
export function masterKeyRingFromEnv(env: NodeJS.ProcessEnv): MasterKeyRing | undefined {
  const current = env["MASTER_KEY"];
  if (!current) return undefined;
  const previous = (env["MASTER_KEY_PREVIOUS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseMasterKey);
  return { current: parseMasterKey(current), previous };
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  const keys = masterKeyRingFromEnv(process.env);
  if (!databaseUrl || !keys) {
    console.error("DATABASE_URL and MASTER_KEY are required (MASTER_KEY_PREVIOUS = the old key).");
    process.exit(1);
  }
  const { db, client } = createDb(databaseUrl);
  try {
    const { rewrapped } = await rotateMasterKey({ db, keys });
    console.log(`Rewrapped ${rewrapped} env var(s) under the current MASTER_KEY.`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "rotation failed");
    process.exit(1);
  });
}
