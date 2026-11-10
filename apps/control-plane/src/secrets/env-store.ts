import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { envVars } from "../db/schema.js";
import { decryptEnvValue, encryptEnvValue, type MasterKeyRing } from "./crypto.js";

export type EnvListing = { key: string; secret: true } | { key: string; secret: false; value: string };

/** Owner-facing listing: secret values are never decrypted here (write-only, INV7). */
export async function listEnv(db: Db["db"], keys: MasterKeyRing, appId: string): Promise<EnvListing[]> {
  const rows = await db.select().from(envVars).where(eq(envVars.appId, appId)).orderBy(asc(envVars.key));
  return rows.map((row) =>
    row.isSecret
      ? { key: row.key, secret: true as const }
      : {
          key: row.key,
          secret: false as const,
          value: decryptEnvValue(keys, { appId, key: row.key }, row.valueCiphertext),
        },
  );
}

/** Every stored var decrypted, for injection at container start only. */
export async function loadRuntimeEnv(
  db: Db["db"],
  keys: MasterKeyRing,
  appId: string,
): Promise<Record<string, string>> {
  const rows = await db.select().from(envVars).where(eq(envVars.appId, appId));
  const env: Record<string, string> = {};
  for (const row of rows) {
    env[row.key] = decryptEnvValue(keys, { appId, key: row.key }, row.valueCiphertext);
  }
  return env;
}

/**
 * Upsert (`string`) or delete (`null`) vars. A key listed in `secretKeys`
 * becomes secret; a key that is already secret stays secret.
 */
export async function writeEnv(
  db: Db["db"],
  keys: MasterKeyRing,
  appId: string,
  changes: Record<string, string | null>,
  secretKeys: Set<string>,
): Promise<void> {
  const entries = Object.entries(changes);
  const toDelete = entries.filter(([, v]) => v === null).map(([k]) => k);
  const toSet = entries.filter((e): e is [string, string] => e[1] !== null);

  await db.transaction(async (tx) => {
    const existing = toSet.length
      ? await tx
          .select({ key: envVars.key, isSecret: envVars.isSecret })
          .from(envVars)
          .where(and(eq(envVars.appId, appId), inArray(envVars.key, toSet.map(([k]) => k))))
      : [];
    const alreadySecret = new Set(existing.filter((r) => r.isSecret).map((r) => r.key));

    if (toDelete.length) {
      await tx.delete(envVars).where(and(eq(envVars.appId, appId), inArray(envVars.key, toDelete)));
    }
    for (const [key, value] of toSet) {
      const isSecret = secretKeys.has(key) || alreadySecret.has(key);
      const valueCiphertext = encryptEnvValue(keys, { appId, key }, value);
      await tx
        .insert(envVars)
        .values({ appId, key, valueCiphertext, isSecret })
        .onConflictDoUpdate({
          target: [envVars.appId, envVars.key],
          set: { valueCiphertext, isSecret, updatedAt: new Date() },
        });
    }
  });
}
