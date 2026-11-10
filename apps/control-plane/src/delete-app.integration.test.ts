import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  Reachable,
  RuntimeProvider,
} from "@scad/runtime-conformance";
import { buildApp, type AppInstance } from "./app.js";
import { issuePat } from "./auth/pat.js";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { appAccess, apps, auditEvents, envVars, machines, pats, releases, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { appendRuntimeLogs } from "./logs/runtime-log-store.js";

const databaseUrl = process.env["DATABASE_URL"];

class RemoveRuntime implements RuntimeProvider {
  removed: { appId: string; deleteVolume: boolean }[] = [];
  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    return { appId: spec.appId, providerId: "p" };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async status(): Promise<MachineStatus> {
    return "running";
  }
  async address(): Promise<Reachable> {
    return { host: "127.0.0.1", port: 1 };
  }
  async *logs(): AsyncIterable<string> {}
  async remove(appId: string, opts: { deleteVolume: boolean }): Promise<void> {
    this.removed.push({ appId, ...opts });
  }
}

describe.runIf(Boolean(databaseUrl))("DELETE /v1/apps/:id (§8)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let runtime: RemoveRuntime;
  let ownerId: string;
  let ownerToken: string;
  let strangerToken: string;

  async function userWithPat(email: string, handle: string) {
    const [u] = await dbBundle.db.insert(users).values({ email, handle }).returning();
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: u!.id, tokenHash: pat.tokenHash, name: "t" });
    return { id: u!.id, token: pat.token };
  }

  async function seedApp(slug: string): Promise<string> {
    const [a] = await dbBundle.db.insert(apps).values({ slug, ownerId, status: "running" }).returning();
    await dbBundle.db.insert(machines).values({ appId: a!.id, providerId: `c-${slug}`, state: "running" });
    await dbBundle.db.insert(appAccess).values({ appId: a!.id, email: "friend@example.com", grantedBy: ownerId });
    await dbBundle.db
      .insert(envVars)
      .values({ appId: a!.id, key: "K", valueCiphertext: Buffer.from("x"), isSecret: true });
    await appendRuntimeLogs(dbBundle.db, [{ appId: a!.id, providerId: `c-${slug}`, line: "hi" }]);
    return a!.id;
  }

  const del = (idOrSlug: string, token?: string) =>
    app.inject({
      method: "DELETE",
      url: `/v1/apps/${idOrSlug}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        runtime_logs, env_vars, app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const owner = await userWithPat("owner@example.com", "owner");
    ownerId = owner.id;
    ownerToken = owner.token;
    strangerToken = (await userWithPat("stranger@example.com", "stranger")).token;
    runtime = new RemoveRuntime();
    app = await buildApp({ db: dbBundle.db, internalToken: "t", runtime });
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  it("owner deletes an app: container and volume removed, shares/env/logs cleared, audited", async () => {
    const appId = await seedApp("doomed");
    const res = await del("doomed", ownerToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ app_id: appId, status: "deleted" });

    expect(runtime.removed).toContainEqual({ appId, deleteVolume: true });
    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.status).toBe("deleted");
    expect(await dbBundle.db.select().from(machines).where(eq(machines.appId, appId))).toHaveLength(0);
    expect(await dbBundle.db.select().from(appAccess).where(eq(appAccess.appId, appId))).toHaveLength(0);
    expect(await dbBundle.db.select().from(envVars).where(eq(envVars.appId, appId))).toHaveLength(0);
    const [logs] = await dbBundle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM runtime_logs WHERE app_id = ${appId}`,
    );
    expect(logs!.n).toBe(0);
    const audit = await dbBundle.db.select().from(auditEvents).where(eq(auditEvents.appId, appId));
    expect(audit.map((a) => a.action)).toContain("app.delete");

    // Gone from the owner's view.
    const get = await app.inject({
      method: "GET",
      url: "/v1/apps/doomed",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(get.statusCode).toBe(404);
  });

  async function seedBuildingRelease(appId: string): Promise<string> {
    const [r] = await dbBundle.db
      .insert(releases)
      .values({
        appId,
        version: 2,
        imageRef: "",
        manifest: {},
        status: "building",
        buildLogRef: "x",
      })
      .returning();
    return r!.id;
  }

  const complete = (releaseId: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/internal/builds/${releaseId}/complete`,
      headers: { "x-scad-internal-token": "t" },
      payload,
    });

  it("a build that finishes after its app was deleted is discarded and its deploy removed", async () => {
    const appId = await seedApp("deleted-mid-build");
    const releaseId = await seedBuildingRelease(appId);

    expect((await del("deleted-mid-build", ownerToken)).statusCode).toBe(200);
    const [cancelled] = await dbBundle.db.select().from(releases).where(eq(releases.id, releaseId));
    expect(cancelled?.status).toBe("failed");
    expect(cancelled?.error).toMatchObject({ code: "NOT_FOUND" });

    // The builder had already deployed; it reports success afterwards.
    const removedBefore = runtime.removed.filter((r) => r.appId === appId).length;
    const res = await complete(releaseId, { ok: true, imageRef: "img", providerId: "late" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, discarded: true });

    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.status).toBe("deleted");
    expect(await dbBundle.db.select().from(machines).where(eq(machines.appId, appId))).toHaveLength(
      0,
    );
    expect(runtime.removed.filter((r) => r.appId === appId).length).toBe(removedBefore + 1);
    const [after] = await dbBundle.db.select().from(releases).where(eq(releases.id, releaseId));
    expect(after?.status).toBe("failed");
  });

  it("a failed build reported after delete leaves the app deleted", async () => {
    const appId = await seedApp("deleted-then-failed");
    const releaseId = await seedBuildingRelease(appId);
    expect((await del("deleted-then-failed", ownerToken)).statusCode).toBe(200);
    const res = await complete(releaseId, {
      ok: false,
      error: { code: "BUILD_FAILED", message: "m", hint: "h", details: {} },
    });
    expect(res.json()).toMatchObject({ discarded: true });
    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.status).toBe("deleted");
  });

  it("claim never hands out a build for a deleted app", async () => {
    const appId = await seedApp("deleted-before-claim");
    await dbBundle.db.update(apps).set({ status: "deleted" }).where(eq(apps.id, appId));
    const releaseId = await seedBuildingRelease(appId);
    const res = await app.inject({
      method: "POST",
      url: "/internal/builds/claim",
      headers: { "x-scad-internal-token": "t" },
    });
    expect(res.json().job?.releaseId).not.toBe(releaseId);
    const [r] = await dbBundle.db.select().from(releases).where(eq(releases.id, releaseId));
    expect(r?.status).toBe("failed");
  });

  it("another user cannot delete it (INV10) and nothing is removed", async () => {
    const appId = await seedApp("kept");
    const before = runtime.removed.length;
    const res = await del("kept", strangerToken);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND", hint: expect.any(String) });
    expect(runtime.removed.length).toBe(before);
    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.status).toBe("running");
  });

  it("requires auth", async () => {
    expect((await del("kept")).statusCode).toBe(401);
  });
});
