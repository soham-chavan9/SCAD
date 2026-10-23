import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp, type AppInstance } from "./app.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { apps, pats, users } from "./db/schema.js";
import { issuePat } from "./auth/pat.js";

const databaseUrl = process.env["DATABASE_URL"];

describe.runIf(Boolean(databaseUrl))("control-plane integration (Postgres)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let patToken: string;
  let userId: string;
  let dataDir: string;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL required");
    }
    dataDir = await mkdtemp(join(tmpdir(), "scad-cp-"));
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);

    // Isolate tables for this suite
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE audit_events, machines, releases, pats, apps, users RESTART IDENTITY CASCADE
    `);

    const issued = issuePat();
    patToken = issued.token;

    const [user] = await dbBundle.db
      .insert(users)
      .values({
        email: "builder@example.com",
        displayName: "Builder",
        handle: "builder",
        role: "member",
        status: "active",
      })
      .returning();
    if (!user) throw new Error("failed to insert user");
    userId = user.id;

    await dbBundle.db.insert(pats).values({
      userId: user.id,
      tokenHash: issued.tokenHash,
      name: "test",
    });

    app = await buildApp({ db: dbBundle.db, dataDir });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("GET /healthz is public", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("POST /v1/apps without token returns 401 UNAUTHENTICATED envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/apps",
      payload: { slug: "hello-app" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: expect.any(String),
      hint: expect.any(String),
      details: {},
    });
  });

  it("POST /v1/apps with valid PAT creates an app row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/apps",
      headers: { authorization: `Bearer ${patToken}` },
      payload: { slug: "hello-app" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      app: { id: string; slug: string; ownerId: string; status: string };
    };
    expect(body.app.slug).toBe("hello-app");
    expect(body.app.ownerId).toBe(userId);
    expect(body.app.status).toBe("stopped");

    const rows = await dbBundle.db.select().from(apps).where(eq(apps.id, body.app.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("hello-app");
  });
});
