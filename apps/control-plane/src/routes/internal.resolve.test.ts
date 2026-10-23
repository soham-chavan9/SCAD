import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp, type AppInstance } from "../app.js";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { apps, pats, releases, users } from "../db/schema.js";
import { issuePat } from "../auth/pat.js";
import { parseAppHost } from "./internal.js";

const databaseUrl = process.env["DATABASE_URL"];
const INTERNAL_SECRET = "test-internal-secret-t08";

describe("parseAppHost INV11", () => {
  const base = "localhost:8080";

  it("accepts valid slug.handle", () => {
    expect(parseAppHost("hello.alice.localhost:8080", base)).toEqual({
      slug: "hello",
      ownerHandle: "alice",
    });
  });

  it.each([
    ["HELLO.alice.localhost:8080", "uppercase slug"],
    ["hello.Alice.localhost:8080", "uppercase handle"],
    ["../x.alice.localhost:8080", "dotdot slug"],
    ["hel/lo.alice.localhost:8080", "slash in slug"],
    ["hello.al ice.localhost:8080", "space in handle"],
    [`${"a".repeat(41)}.alice.localhost:8080`, "over-length slug"],
    ["hello;rm.alice.localhost:8080", "shell char in slug"],
    ["hello.аlice.localhost:8080", "unicode lookalike handle"],
  ])("rejects %s (%s)", (host) => {
    expect(parseAppHost(host, base)).toBeNull();
  });
});

describe.runIf(Boolean(databaseUrl))("/internal/resolve uses manifest port", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let dataDir: string;
  let appId: string;
  let ownerHandle: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    dataDir = await mkdtemp(join(tmpdir(), "scad-resolve-"));
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);

    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);

    const issued = issuePat();
    const [user] = await dbBundle.db
      .insert(users)
      .values({
        email: "resolve-owner@example.com",
        displayName: "Resolve Owner",
        handle: "resolveowner",
        role: "member",
        status: "active",
      })
      .returning();
    if (!user) throw new Error("user insert failed");
    ownerHandle = user.handle;

    await dbBundle.db.insert(pats).values({
      userId: user.id,
      tokenHash: issued.tokenHash,
      name: "test",
    });

    const [appRow] = await dbBundle.db
      .insert(apps)
      .values({
        slug: "portapp",
        ownerId: user.id,
        status: "running",
        visibility: "allowlist",
      })
      .returning();
    if (!appRow) throw new Error("app insert failed");
    appId = appRow.id;

    await dbBundle.db.insert(releases).values({
      appId,
      version: 1,
      imageRef: "scad-apps/portapp:v1",
      manifest: { name: "portapp", port: 3456 },
      status: "ready",
    });

    app = await buildApp({
      db: dbBundle.db,
      dataDir,
      baseDomain: "localhost:8080",
      internalSecret: INTERNAL_SECRET,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("returns manifest port not hardcoded 8080", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      headers: {
        "content-type": "application/json",
        "x-scad-internal-secret": INTERNAL_SECRET,
      },
      payload: { host: `portapp.${ownerHandle}.localhost:8080` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { appId: string; port: number };
    expect(body.appId).toBe(appId);
    expect(body.port).toBe(3456);
  });

  it("defaults to 8080 when no ready release", async () => {
    await dbBundle.db
      .update(releases)
      .set({ status: "failed" })
      .where(eq(releases.appId, appId));

    const res = await app.inject({
      method: "POST",
      url: "/internal/resolve",
      headers: {
        "content-type": "application/json",
        "x-scad-internal-secret": INTERNAL_SECRET,
      },
      payload: { host: `portapp.${ownerHandle}.localhost:8080` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { port: number }).port).toBe(8080);
  });
});
