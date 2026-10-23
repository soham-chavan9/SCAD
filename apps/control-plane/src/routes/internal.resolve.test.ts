import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@scad/shared";
import { buildApp, type AppInstance } from "../app.js";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { apps, releases, users } from "../db/schema.js";

const databaseUrl = process.env["DATABASE_URL"];

describe.runIf(Boolean(databaseUrl))("/internal/resolve uses manifest port", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let dataDir: string;
  const secret = "test-internal-secret";

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    dataDir = await mkdtemp(join(tmpdir(), "scad-resolve-"));
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    app = await buildApp({
      db: dbBundle.db,
      dataDir,
      baseDomain: "localhost:8080",
      internalSecret: secret,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("returns port from latest ready release manifest (not hardcoded 8080)", async () => {
    const ownerId = newId();
    const appId = newId();
    const handle = `owner${ownerId.slice(0, 8)}`;
    await dbBundle.db.insert(users).values({
      id: ownerId,
      email: `${handle}@example.com`,
      handle,
      displayName: "Owner",
    });
    await dbBundle.db.insert(apps).values({
      id: appId,
      slug: "custom-port",
      ownerId,
      status: "running",
    });
    await dbBundle.db.insert(releases).values({
      id: newId(),
      appId,
      version: 1,
      status: "ready",
      imageRef: "scad-apps/test:v1",
      manifest: { name: "custom-port", port: 3456 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      headers: { "x-scad-internal-secret": secret },
      payload: { host: `custom-port.${handle}.localhost:8080` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { port: number; appId: string };
    expect(body.appId).toBe(appId);
    expect(body.port).toBe(3456);

    await dbBundle.db.delete(releases).where(eq(releases.appId, appId));
    await dbBundle.db.delete(apps).where(eq(apps.id, appId));
    await dbBundle.db.delete(users).where(eq(users.id, ownerId));
  });

  it("defaults to 8080 when no ready release", async () => {
    const ownerId = newId();
    const appId = newId();
    const handle = `owner${ownerId.slice(0, 8)}`;
    await dbBundle.db.insert(users).values({
      id: ownerId,
      email: `${handle}@example.com`,
      handle,
      displayName: "Owner",
    });
    await dbBundle.db.insert(apps).values({
      id: appId,
      slug: "no-release",
      ownerId,
      status: "building",
    });

    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      headers: { "x-scad-internal-secret": secret },
      payload: { host: `no-release.${handle}.localhost:8080` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { port: number }).port).toBe(8080);

    await dbBundle.db.delete(apps).where(eq(apps.id, appId));
    await dbBundle.db.delete(users).where(eq(users.id, ownerId));
  });

  it("rejects bad slug/handle hosts (INV11)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      headers: { "x-scad-internal-secret": secret },
      payload: { host: `BadSlug.alice.localhost:8080` },
    });
    // parseAppHost does not lowercase — BadSlug fails isSlug.
    expect(res.statusCode).toBe(404);
  });
});
