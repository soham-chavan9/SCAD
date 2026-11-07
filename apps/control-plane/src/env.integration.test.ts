import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { decryptEnvValue, type MasterKeyRing } from "./secrets/crypto.js";
import { rotateMasterKey } from "./secrets/rotate.js";

const databaseUrl = process.env["DATABASE_URL"];
const SECRET = "tok-SECRET-9f8e7d6c";
const INTERNAL_TOKEN = "env-internal-token";

class RecordingRuntime implements RuntimeProvider {
  deploys: DeploySpec[] = [];
  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    this.deploys.push(spec);
    return { appId: spec.appId, providerId: `p-${this.deploys.length}` };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async status(): Promise<MachineStatus> {
    return "running";
  }
  async address(): Promise<Reachable> {
    return { host: "127.0.0.1", port: 1 };
  }
  // eslint-disable-next-line require-yield
  async *logs(): AsyncIterable<string> {
    return;
  }
  async remove(): Promise<void> {}
}

describe.runIf(Boolean(databaseUrl))("env vars and encrypted secrets (T1.6)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let runtime: RecordingRuntime;
  let masterKey: Buffer;
  let ownerToken: string;
  let strangerToken: string;
  let viewerToken: string;
  let appId: string;
  let releaseId: string;
  const output: string[] = [];

  async function userWithPat(email: string, handle: string): Promise<{ id: string; token: string }> {
    const [u] = await dbBundle.db.insert(users).values({ email, handle }).returning();
    if (!u) throw new Error("user insert failed");
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: u.id, tokenHash: pat.tokenHash, name: "t" });
    return { id: u.id, token: pat.token };
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    // INV12: capture everything the process prints while the tests run.
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        output.push(String(chunk));
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await app?.close();
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        env_vars, app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const owner = await userWithPat("owner@example.com", "owner");
    ownerToken = owner.token;
    strangerToken = (await userWithPat("stranger@example.com", "stranger")).token;
    viewerToken = (await userWithPat("viewer@example.com", "viewer")).token;

    const [a] = await dbBundle.db
      .insert(apps)
      .values({ slug: "env-app", ownerId: owner.id, status: "running" })
      .returning();
    if (!a) throw new Error("app insert failed");
    appId = a.id;
    await dbBundle.db.insert(appAccess).values({ appId, email: "viewer@example.com", grantedBy: owner.id });
    const [r] = await dbBundle.db
      .insert(releases)
      .values({
        appId,
        version: 1,
        imageRef: "scad-apps/x:v1",
        status: "ready",
        manifest: {
          port: 3000,
          env: { NODE_ENV: "production", DB_URL: "from-manifest" },
          egress: [],
          resources: { memory_mb: 256, disk_gb: 1 },
          frame_ancestors: "self",
        },
      })
      .returning();
    if (!r) throw new Error("release insert failed");
    releaseId = r.id;
    await dbBundle.db.insert(machines).values({ appId, providerId: "p-0", state: "running" });

    masterKey = randomBytes(32);
    runtime = new RecordingRuntime();
    app = await buildApp({
      db: dbBundle.db,
      internalToken: INTERNAL_TOKEN,
      masterKeys: { current: masterKey, previous: [] },
      runtime,
    });
  });

  const put = (token: string, payload: unknown, idOrSlug = "env-app") =>
    app.inject({
      method: "PUT",
      url: `/v1/apps/${idOrSlug}/env`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });
  const get = (token: string, idOrSlug = "env-app") =>
    app.inject({
      method: "GET",
      url: `/v1/apps/${idOrSlug}/env`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("stores values encrypted and never returns secrets", async () => {
    const res = await put(ownerToken, { DB_URL: "postgres://db/app", API_TOKEN: SECRET, secret: ["API_TOKEN"] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(SECRET);

    const listed = await get(ownerToken);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(SECRET);
    expect(listed.json()).toEqual({
      env: [
        { key: "API_TOKEN", secret: true },
        { key: "DB_URL", secret: false, value: "postgres://db/app" },
      ],
    });

    const rows = await dbBundle.db.select().from(envVars).where(eq(envVars.appId, appId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.valueCiphertext.includes(Buffer.from(SECRET))).toBe(false);
      expect(row.valueCiphertext.includes(Buffer.from("postgres://db/app"))).toBe(false);
    }
    expect(rows.find((r) => r.key === "API_TOKEN")?.isSecret).toBe(true);
  });

  it("writes an audit row with key names only", async () => {
    await put(ownerToken, { API_TOKEN: SECRET, secret: ["API_TOKEN"] });
    const events = await dbBundle.db.select().from(auditEvents).where(eq(auditEvents.appId, appId));
    const envEvent = events.find((e) => e.action === "app.env.set");
    expect(envEvent).toBeDefined();
    expect(JSON.stringify(envEvent?.metadata)).not.toContain(SECRET);
    expect(envEvent?.metadata).toMatchObject({ set: ["API_TOKEN"] });
  });

  it("only the owner can read or change env (INV10)", async () => {
    for (const token of [strangerToken, viewerToken]) {
      expect((await put(token, { A: "1" })).statusCode).toBe(404);
      expect((await get(token)).statusCode).toBe(404);
      expect((await put(token, { A: "1" }, appId)).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: "/v1/apps/env-app/env" })).statusCode).toBe(401);
  });

  it("validates keys, values, and the secret list", async () => {
    for (const payload of [
      { "1BAD": "x" },
      { "A-B": "x" },
      { A: 5 },
      { A: "x", secret: ["B"] },
      { A: "x", secret: "A" },
      {},
    ]) {
      const res = await put(ownerToken, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", hint: expect.any(String) });
    }
  });

  it("null deletes a key", async () => {
    await put(ownerToken, { A: "1", B: "2" });
    const res = await put(ownerToken, { A: null });
    expect(res.statusCode).toBe(200);
    expect((await get(ownerToken)).json()).toEqual({ env: [{ key: "B", secret: false, value: "2" }] });
  });

  it("changing env redeploys the current release with the new values injected at start", async () => {
    const res = await put(ownerToken, { API_TOKEN: SECRET, DB_URL: "override", secret: ["API_TOKEN"] });
    expect(res.json()).toMatchObject({ applied: "redeployed" });
    expect(runtime.deploys).toHaveLength(1);
    const spec = runtime.deploys[0]!;
    expect(spec).toMatchObject({ appId, imageRef: "scad-apps/x:v1", port: 3000 });
    // Manifest env first, stored env vars override it.
    expect(spec.env).toEqual({ NODE_ENV: "production", DB_URL: "override", API_TOKEN: SECRET });
    expect(spec.limits.memoryMb).toBe(256);
    const [m] = await dbBundle.db.select().from(machines).where(eq(machines.appId, appId));
    expect(m?.providerId).toBe("p-1");
  });

  it("the builder fetches decrypted env just in time, only for a release it is building", async () => {
    await put(ownerToken, { API_TOKEN: SECRET, secret: ["API_TOKEN"] });
    const [building] = await dbBundle.db
      .insert(releases)
      .values({ appId, version: 2, status: "building" })
      .returning();

    const noToken = await app.inject({ method: "POST", url: `/internal/builds/${building!.id}/runtime-env` });
    expect(noToken.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST",
      url: `/internal/builds/${building!.id}/runtime-env`,
      headers: { "x-scad-internal-token": INTERNAL_TOKEN },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ env: { API_TOKEN: SECRET } });

    const notBuilding = await app.inject({
      method: "POST",
      url: `/internal/builds/${releaseId}/runtime-env`,
      headers: { "x-scad-internal-token": INTERNAL_TOKEN },
    });
    expect(notBuilding.statusCode).toBe(409);
  });

  it("refuses to store env without MASTER_KEY", async () => {
    const noKey = await buildApp({ db: dbBundle.db, internalToken: INTERNAL_TOKEN });
    try {
      const res = await noKey.inject({
        method: "PUT",
        url: "/v1/apps/env-app/env",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { A: "1" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "INTERNAL", hint: expect.stringMatching(/MASTER_KEY/) });
    } finally {
      await noKey.close();
    }
  });

  it("MASTER_KEY rotation rewraps every record", async () => {
    await put(ownerToken, { API_TOKEN: SECRET, DB_URL: "x", secret: ["API_TOKEN"] });
    const newKey = randomBytes(32);
    const ring: MasterKeyRing = { current: newKey, previous: [masterKey] };
    const result = await rotateMasterKey({ db: dbBundle.db, keys: ring });
    expect(result).toEqual({ rewrapped: 2 });

    const rows = await dbBundle.db.select().from(envVars).where(eq(envVars.appId, appId));
    const token = rows.find((r) => r.key === "API_TOKEN")!;
    const onlyNew: MasterKeyRing = { current: newKey, previous: [] };
    expect(decryptEnvValue(onlyNew, { appId, key: "API_TOKEN" }, token.valueCiphertext)).toBe(SECRET);
    const onlyOld: MasterKeyRing = { current: masterKey, previous: [] };
    expect(() => decryptEnvValue(onlyOld, { appId, key: "API_TOKEN" }, token.valueCiphertext)).toThrow();
  });

  it("never prints secret values (INV12)", () => {
    expect(output.join("")).not.toContain(SECRET);
  });
});
