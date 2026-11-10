import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPublishTarball } from "@scad/cli";
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
import {
  apps,
  auditEvents,
  invites,
  machines,
  pats,
  releases,
  sessions,
  users,
} from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";

const databaseUrl = process.env["DATABASE_URL"];

class StopRuntime implements RuntimeProvider {
  stopped: string[] = [];
  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    return { appId: spec.appId, providerId: `p-${spec.appId}` };
  }
  async start(): Promise<void> {}
  async stop(m: MachineRef): Promise<void> {
    this.stopped.push(m.appId);
  }
  async status(): Promise<MachineStatus> {
    return "running";
  }
  async address(): Promise<Reachable> {
    return { host: "127.0.0.1", port: 1 };
  }
  async *logs(): AsyncIterable<string> {}
  async remove(): Promise<void> {}
}

/** T2.6: operator controls (suspend apps and users, invites) and the audit trail. */
describe.runIf(Boolean(databaseUrl))("operator controls and audit (T2.6)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let runtime: StopRuntime;
  let baseUrl: string;
  let workDir: string;
  let tarball: Buffer;
  let operator: { id: string; token: string };
  let member: { id: string; token: string };

  async function userWithPat(email: string, handle: string) {
    const [u] = await dbBundle.db.insert(users).values({ email, handle }).returning();
    const pat = issuePat();
    await dbBundle.db.insert(pats).values({ userId: u!.id, tokenHash: pat.tokenHash, name: "t" });
    return { id: u!.id, token: pat.token };
  }

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function publish(name: string, token: string) {
    const form = new FormData();
    form.append("tarball", new Blob([new Uint8Array(tarball)]), "app.tar");
    form.append("name", name);
    const res = await fetch(`${baseUrl}/v1/apps/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function runningApp(slug: string, ownerId: string): Promise<string> {
    const [a] = await dbBundle.db
      .insert(apps)
      .values({ slug, ownerId, status: "running" })
      .returning();
    await dbBundle.db
      .insert(machines)
      .values({ appId: a!.id, providerId: `c-${slug}`, state: "running" });
    return a!.id;
  }

  const actions = async (appId?: string) =>
    (
      await dbBundle.db
        .select()
        .from(auditEvents)
        .where(appId ? eq(auditEvents.appId, appId) : undefined)
    ).map((e) => e.action);

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    workDir = await mkdtemp(join(tmpdir(), "scad-admin-"));
    const src = await mkdtemp(join(workDir, "src-"));
    await writeFile(join(src, "Dockerfile"), "FROM node:22-alpine\nUSER node\n");
    tarball = await createPublishTarball(src);
    runtime = new StopRuntime();
    app = await buildApp({
      db: dbBundle.db,
      dataDir: workDir,
      internalToken: "t",
      operatorEmails: ["Op@Example.com"],
      runtime,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(async () => {
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        invites, runtime_logs, env_vars, app_access, magic_links, oauth_states, login_codes, sessions,
        audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    runtime.stopped = [];
    operator = await userWithPat("op@example.com", "op");
    member = await userWithPat("mem@example.com", "mem");
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    await rm(workDir, { recursive: true, force: true });
  });

  it.each([
    ["GET", "/v1/admin/users"],
    ["GET", "/v1/admin/audit"],
    ["GET", "/v1/admin/invites"],
    ["POST", "/v1/admin/invites"],
    ["DELETE", "/v1/admin/invites/x%40example.com"],
    ["POST", "/v1/admin/users/op@example.com/suspend"],
    ["POST", "/v1/admin/users/op@example.com/unsuspend"],
    ["POST", "/v1/admin/apps/00000000-0000-4000-8000-000000000000/suspend"],
    ["POST", "/v1/admin/apps/00000000-0000-4000-8000-000000000000/unsuspend"],
  ])("a non-operator gets 403 FORBIDDEN on %s %s", async (method, path) => {
    const res = await call(
      method,
      path,
      member.token,
      method === "POST" ? { email: "x@example.com" } : undefined,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", hint: expect.stringMatching(/operator/i) });
  });

  it("OPERATOR_EMAILS users are operators (case-insensitive) and see everyone", async () => {
    const res = await call("GET", "/v1/admin/users", operator.token);
    expect(res.status).toBe(200);
    const list = res.body["users"] as { email: string; role: string }[];
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "op@example.com", role: "operator" }),
        expect.objectContaining({ email: "mem@example.com", role: "member" }),
      ]),
    );
  });

  it("suspending an app stops it, blocks republish, and is audited; unsuspend lifts it", async () => {
    const appId = await runningApp("board", member.id);
    const res = await call("POST", `/v1/admin/apps/mem%2Fboard/suspend`, operator.token);
    expect(res.status).toBe(200);
    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.status).toBe("suspended");
    expect(runtime.stopped).toContain(appId);
    expect(await actions(appId)).toContain("app.suspend");

    const again = await publish("board", member.token);
    expect(again.status).toBe(403);
    expect(again.body).toMatchObject({
      code: "APP_SUSPENDED",
      hint: expect.stringMatching(/operator/i),
    });

    const lift = await call("POST", `/v1/admin/apps/${appId}/unsuspend`, operator.token);
    expect(lift.status).toBe(200);
    const [after] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(after?.status).toBe("stopped");
    expect(await actions(appId)).toContain("app.unsuspend");
  });

  it("a build that finishes after its app was suspended keeps the release but leaves the app stopped", async () => {
    const appId = await runningApp("mid-build", member.id);
    const [rel] = await dbBundle.db
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
    await call("POST", `/v1/admin/apps/${appId}/suspend`, operator.token);
    runtime.stopped = [];
    const done = await app.inject({
      method: "POST",
      url: `/internal/builds/${rel!.id}/complete`,
      headers: { "x-scad-internal-token": "t" },
      payload: { ok: true, imageRef: "img:2", providerId: "c-new" },
    });
    expect(done.statusCode).toBe(200);
    const [row] = await dbBundle.db.select().from(apps).where(eq(apps.id, appId));
    expect(row?.status).toBe("suspended");
    expect(runtime.stopped).toContain(appId);
  });

  it("suspending a user refuses their PAT, revokes their sessions, stops their apps, and is audited", async () => {
    const appId = await runningApp("mine", member.id);
    await dbBundle.db
      .insert(sessions)
      .values({
        userId: member.id,
        appHost: "x.mem.localhost:8080",
        expiresAt: new Date(Date.now() + 3600_000),
      });
    const res = await call("POST", "/v1/admin/users/MEM@example.com/suspend", operator.token);
    expect(res.status).toBe(200);
    expect(res.body["user"]).toMatchObject({ status: "suspended" });

    expect((await call("GET", "/v1/apps", member.token)).status).toBe(401);
    const live = await dbBundle.db.select().from(sessions).where(eq(sessions.userId, member.id));
    expect(live.every((s) => s.revokedAt !== null)).toBe(true);
    expect(runtime.stopped).toContain(appId);
    expect(await actions()).toContain("user.suspend");

    expect(
      (await call("POST", `/v1/admin/users/${member.id}/unsuspend`, operator.token)).status,
    ).toBe(200);
    expect((await call("GET", "/v1/apps", member.token)).status).toBe(200);
    expect(await actions()).toContain("user.unsuspend");
  });

  it("an operator cannot suspend themself", async () => {
    const res = await call("POST", "/v1/admin/users/op@example.com/suspend", operator.token);
    expect(res.status).toBe(400);
  });

  it("invite add / ls / rm, normalized, idempotent, and audited", async () => {
    const add = await call("POST", "/v1/admin/invites", operator.token, {
      email: " Friend@Example.COM ",
    });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ email: "friend@example.com", created: true });
    const again = await call("POST", "/v1/admin/invites", operator.token, {
      email: "friend@example.com",
    });
    expect(again.body).toMatchObject({ created: false });
    const ls = await call("GET", "/v1/admin/invites", operator.token);
    expect(ls.body["invites"]).toEqual([
      expect.objectContaining({ email: "friend@example.com", invited_by: "op@example.com" }),
    ]);
    const rm = await call("DELETE", "/v1/admin/invites/friend%40example.com", operator.token);
    expect(rm.body).toMatchObject({ removed: true });
    expect(await dbBundle.db.select().from(invites)).toHaveLength(0);
    const all = await actions();
    expect(all.filter((a) => a === "invite.add")).toHaveLength(1);
    expect(all).toContain("invite.remove");
    expect(
      (await call("POST", "/v1/admin/invites", operator.token, { email: "nope" })).status,
    ).toBe(400);
  });

  it("every publish, share, unshare, suspend, and delete writes an audit_events row", async () => {
    const pub = await publish("audited", member.token);
    expect(pub.status).toBe(202);
    const appId = (pub.body["app"] as { id: string }).id;
    expect(
      (await call("POST", `/v1/apps/${appId}/share`, member.token, { email: "f@example.com" }))
        .status,
    ).toBe(201);
    expect(
      (await call("DELETE", `/v1/apps/${appId}/share/f%40example.com`, member.token)).status,
    ).toBe(200);
    expect((await call("POST", `/v1/admin/apps/${appId}/suspend`, operator.token)).status).toBe(
      200,
    );
    expect((await call("DELETE", `/v1/apps/${appId}`, member.token)).status).toBe(200);

    expect(await actions(appId)).toEqual(
      expect.arrayContaining([
        "app.publish",
        "app.share",
        "app.unshare",
        "app.suspend",
        "app.delete",
      ]),
    );
    const feed = await call("GET", `/v1/admin/audit?limit=20`, operator.token);
    const events = feed.body["events"] as { action: string; actor: string | null }[];
    expect(events.find((e) => e.action === "app.suspend")?.actor).toBe("op@example.com");
    expect(events.find((e) => e.action === "app.publish")?.actor).toBe("mem@example.com");
  });
});
