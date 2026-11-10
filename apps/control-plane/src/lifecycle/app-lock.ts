import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/** A transaction handle (what `db.transaction` passes to its callback). */
export type Tx = Parameters<Parameters<Db["db"]["transaction"]>[0]>[0];

/** Namespace for per-app locks (two-key advisory lock: namespace, hash of the app id). */
const APP_LOCK_NAMESPACE = 0x5cad_0002;

/**
 * Hold a per-app lock until the transaction ends. Deleting an app, publishing
 * to it, and completing one of its builds take this lock, so a delete never
 * races a republish or a build that is finishing.
 */
export async function lockApp(tx: Tx, appId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${APP_LOCK_NAMESPACE}, hashtext(${appId}))`);
}
