/**
 * Control plane for scripts/tls-smoke.sh (T3.1): the real API routes, no
 * runtime, with one seeded app so the ask endpoint has something to allow.
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { apps, users } from "../src/db/schema.js";

const databaseUrl = process.env["DATABASE_URL"];
const baseDomain = process.env["BASE_DOMAIN"];
const port = Number(process.env["TLS_SMOKE_CP_PORT"] ?? 4100);
if (!databaseUrl || !baseDomain) throw new Error("DATABASE_URL and BASE_DOMAIN are required");

await runMigrations(databaseUrl);
const { db } = createDb(databaseUrl);
let [owner] = await db.select().from(users).where(eq(users.handle, "tlssmoke")).limit(1);
if (!owner) {
  [owner] = await db
    .insert(users)
    .values({ email: "tls-smoke@example.com", displayName: "", handle: "tlssmoke", role: "member", status: "active" })
    .returning();
}
if (!owner) throw new Error("could not create the smoke user");
const existing = await db
  .select({ id: apps.id })
  .from(apps)
  .where(and(eq(apps.ownerId, owner.id), eq(apps.slug, "hello-static")))
  .limit(1);
if (existing.length === 0) {
  await db.insert(apps).values({ slug: "hello-static", ownerId: owner.id, status: "running" });
}

const app = await buildApp({ db, baseDomain, internalToken: "tls-smoke-only" });
await app.listen({ port, host: "0.0.0.0" });
console.log(`tls-smoke control plane on :${port} for ${baseDomain}`);
