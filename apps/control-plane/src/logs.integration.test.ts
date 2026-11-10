import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
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
import { appAccess, apps, machines, pats, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { LOG_RETENTION_MS, pruneBuildLogs } from "./log-retention.js";
import { appendRuntimeLogs } from "./logs/runtime-log-store.js";
import { createDataPaths, ensureDataDirs } from "./storage.js";

const databaseUrl = process.env["DATABASE_URL"];

/** Fake runtime whose follow stream emits a line every 50 ms until the consumer stops. */
class LogRuntime implements RuntimeProvider {
  lastOpts: { follow: boolean; tail?: number } | null = null;
  streamsClosed = 0;
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
  async *logs(_m: MachineRef, opts: { follow: boolean; tail?: number }): AsyncIterable<string> {
    this.lastOpts = opts;
    try {
      yield "line one";
      yield "line two";
      if (!opts.follow) return;
      for (let i = 3; ; i++) {
        await new Promise((r) => setTimeout(r, 50));
        yield `line ${i}`;
      }
    } finally {
      this.streamsClosed += 1;
    }
  }
  async remove(): Promise<void> {}
}

describe.runIf(Boolean(databaseUrl))("runtime logs route (T1.7, store-backed since T1.7b)", () => {
  let dbBundle: Db;
  let app: AppInstance;
  let baseUrl: string;
  let runtime: LogRuntime;
  let ownerToken: string;
  let viewerToken: string;
  let strangerToken: string;
  let logAppId: string;

  async function userWithPat(email: string, handle: string) {
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
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        runtime_logs, env_vars, app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const owner = await userWithPat("owner@example.com", "owner");
    ownerToken = owner.token;
    viewerToken = (await userWithPat("viewer@example.com", "viewer")).token;
    strangerToken = (await userWithPat("stranger@example.com", "stranger")).token;
    const [a] = await dbBundle.db
      .insert(apps)
      .values([
        { slug: "log-app", ownerId: owner.id, status: "running" },
        { slug: "never-deployed", ownerId: owner.id, status: "building" },
      ])
      .returning();
    logAppId = a!.id;
    await dbBundle.db.insert(machines).values({ appId: a!.id, providerId: "p", state: "running" });
    await dbBundle.db.insert(appAccess).values({ appId: a!.id, email: "viewer@example.com", grantedBy: owner.id });

    runtime = new LogRuntime();
    app = await buildApp({ db: dbBundle.db, internalToken: "t", runtime });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  const logsUrl = (slug: string, query = "") => `${baseUrl}/v1/apps/${slug}/logs${query}`;

  it("returns recent lines from the log store as server-sent events and ends", async () => {
    await appendRuntimeLogs(
      dbBundle.db,
      ["line one", "line two"].map((line) => ({ appId: logAppId, providerId: "p", line })),
    );
    const res = await fetch(logsUrl("log-app", "?tail=20"), {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const body = await res.text();
    expect(body).toContain("data: line one\n\n");
    expect(body).toContain("data: line two\n\n");
    expect(body).toContain("event: end");
    // Read from SCAD's store, not the runtime.
    expect(runtime.lastOpts).toBeNull();
  });

  it("follow streams lines as they land in the store and stops when the client disconnects", async () => {
    const controller = new AbortController();
    const res = await fetch(logsUrl("log-app", "?follow=1&tail=0"), {
      headers: { authorization: `Bearer ${ownerToken}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await appendRuntimeLogs(dbBundle.db, [{ appId: logAppId, providerId: "p", line: "live one" }]);
    let text = "";
    while (!text.includes("live one")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("data: live one\n\n");
    expect(text).not.toContain("line one");
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("only the owner can read logs (viewers and strangers get 404)", async () => {
    for (const token of [viewerToken, strangerToken]) {
      const res = await fetch(logsUrl("log-app"), { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await fetch(logsUrl("log-app"))).status).toBe(401);
  });

  it("an app with no machine yet says so", async () => {
    const res = await fetch(logsUrl("never-deployed"), { headers: { authorization: `Bearer ${ownerToken}` } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND", hint: expect.stringMatching(/publish/) });
  });

  it("rejects a bad tail", async () => {
    const res = await fetch(logsUrl("log-app", "?tail=-5"), { headers: { authorization: `Bearer ${ownerToken}` } });
    expect(res.status).toBe(400);
  });
});

describe("log retention job (T1.7)", () => {
  it("deletes build logs older than 7 days and keeps newer ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "scad-logs-"));
    try {
      const paths = createDataPaths(root);
      await ensureDataDirs(paths);
      const now = new Date("2026-11-07T12:00:00Z");
      const old = paths.logPath("00000000-0000-4000-8000-000000000001");
      const fresh = paths.logPath("00000000-0000-4000-8000-000000000002");
      await writeFile(old, "old\n");
      await writeFile(fresh, "fresh\n");
      const oldTime = new Date(now.getTime() - LOG_RETENTION_MS - 60_000);
      await utimes(old, oldTime, oldTime);
      const freshTime = new Date(now.getTime() - 60_000);
      await utimes(fresh, freshTime, freshTime);

      const result = await pruneBuildLogs(paths, now);
      expect(result).toEqual({ deleted: 1 });
      expect(await readdir(join(root, "logs"))).toEqual(["00000000-0000-4000-8000-000000000002.log"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
