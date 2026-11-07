import { createServer, type Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  Reachable,
  RuntimeProvider,
} from "@scad/runtime-conformance";
import {
  assertTruncateAllowed,
  buildApp as buildControlPlane,
  createDb,
  runMigrations,
  schema,
  type Db,
} from "@scad/control-plane";
import { FakeIdentityProvider } from "./auth/identity.js";
import { createSession } from "./auth/sessions.js";
import { buildGateway, type GatewayInstance } from "./app.js";
import { SESSION_COOKIE } from "./cookies.js";
import { appHost } from "./host.js";
import { generateEphemeralIdentityKeys } from "./identity/keys.js";
import { MemoryMailer } from "./mail/mailer.js";
import type { AppResolver, ResolvedApp } from "./resolve.js";
import type { MachineClient } from "./wake.js";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const INTERNAL_SECRET = "wake-gw-secret";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const addr = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

/** Fake runtime: `start` brings a real HTTP upstream up on a fixed port. */
class UpstreamRuntime implements RuntimeProvider {
  starts = 0;
  startDelayMs = 100;
  server: Server | null = null;
  constructor(readonly port: number) {}

  async ensureApp(): Promise<void> {}
  async deploy(spec: DeploySpec): Promise<MachineRef> {
    return { appId: spec.appId, providerId: "p" };
  }
  async start(): Promise<void> {
    this.starts += 1;
    await new Promise((r) => setTimeout(r, this.startDelayMs));
    if (this.server) return;
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(this.port, "127.0.0.1", () => r()));
    this.server = server;
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
  async status(): Promise<MachineStatus> {
    return this.server ? "running" : "stopped";
  }
  async address(): Promise<Reachable> {
    return { host: "127.0.0.1", port: this.port };
  }
  // eslint-disable-next-line require-yield
  async *logs(): AsyncIterable<string> {
    return;
  }
  async remove(): Promise<void> {
    await this.stop();
  }
}

describe.runIf(Boolean(databaseUrl))("gateway wake on request (T1.4)", () => {
  let dbBundle: Db;
  let runtime: UpstreamRuntime;
  let controlPlane: Awaited<ReturnType<typeof buildControlPlane>>;
  let appId: string;
  let ownerId: string;
  let cookie: string;
  let wakeCalls: number;
  let touchCalls: number;
  const host = appHost("sleepy", "owner", BASE_DOMAIN);

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
  });

  afterAll(async () => {
    await runtime?.stop();
    await controlPlane?.close();
    await dbBundle?.client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await runtime?.stop();
    await controlPlane?.close();
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const [owner] = await dbBundle.db
      .insert(schema.users)
      .values({ email: "owner@example.com", handle: "owner" })
      .returning();
    if (!owner) throw new Error("owner insert failed");
    ownerId = owner.id;
    const [app] = await dbBundle.db
      .insert(schema.apps)
      .values({ slug: "sleepy", ownerId, status: "stopped" })
      .returning();
    if (!app) throw new Error("app insert failed");
    appId = app.id;
    await dbBundle.db.insert(schema.machines).values({
      appId,
      providerId: "p",
      state: "stopped",
      lastRequestAt: new Date(Date.now() - 60 * 60_000),
    });
    const session = await createSession(dbBundle.db, { userId: ownerId, appHost: host });
    cookie = `${SESSION_COOKIE}=${session.id}`;

    runtime = new UpstreamRuntime(await freePort());
    controlPlane = await buildControlPlane({
      db: dbBundle.db,
      internalSecret: INTERNAL_SECRET,
      internalToken: "t",
      baseDomain: BASE_DOMAIN,
      runtime,
    });
    await controlPlane.ready();
    wakeCalls = 0;
    touchCalls = 0;
  });

  async function gatewayWith(opts: { wakeBudgetMs?: number; htmlHoldMs?: number }) {
    const resolver: AppResolver = {
      async resolve(h: string) {
        const res = await controlPlane.inject({
          method: "POST",
          url: "/internal/resolve",
          headers: { "x-scad-internal-secret": INTERNAL_SECRET },
          payload: { host: h },
        });
        if (res.statusCode === 404) return null;
        const base = res.json() as ResolvedApp;
        return { ...base, upstreamHost: "127.0.0.1", port: runtime.port };
      },
    };
    const machines: MachineClient = {
      async wake(id: string) {
        wakeCalls += 1;
        const res = await controlPlane.inject({
          method: "POST",
          url: "/internal/wake",
          headers: { "x-scad-internal-secret": INTERNAL_SECRET },
          payload: { appId: id },
        });
        if (res.statusCode !== 200) throw new Error(`wake ${res.statusCode}`);
      },
      async touch(id: string, userId: string) {
        touchCalls += 1;
        await controlPlane.inject({
          method: "POST",
          url: "/internal/touch",
          headers: { "x-scad-internal-secret": INTERNAL_SECRET },
          payload: { appId: id, userId },
        });
      },
    };
    const gw: GatewayInstance = await buildGateway({
      db: dbBundle.db,
      baseDomain: BASE_DOMAIN,
      identity: new FakeIdentityProvider(),
      resolver,
      keys: await generateEphemeralIdentityKeys(),
      mailer: new MemoryMailer(),
      machines,
      ...opts,
    });
    await gw.ready();
    return gw;
  }

  it("serves the first request to a stopped app well within 10 s", async () => {
    const gw = await gatewayWith({});
    try {
      const t0 = Date.now();
      const res = await gw.inject({
        method: "GET",
        url: "/api",
        headers: { host, cookie, accept: "application/json" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(runtime.starts).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it("a storm of 50 concurrent requests triggers exactly one wake and one start", async () => {
    runtime.startDelayMs = 500;
    const gw = await gatewayWith({});
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          gw.inject({
            method: "GET",
            url: `/api/${i}`,
            headers: { host, cookie, accept: "application/json" },
          }),
        ),
      );
      for (const res of results) expect(res.statusCode, res.body).toBe(200);
      expect(wakeCalls).toBe(1);
      expect(runtime.starts).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it("HTML navigations get a self-retrying wait page while the app starts", async () => {
    runtime.startDelayMs = 1500;
    const gw = await gatewayWith({ htmlHoldMs: 100 });
    try {
      const res = await gw.inject({
        method: "GET",
        url: "/dashboard?tab=1",
        headers: { host, cookie, accept: "text/html,application/xhtml+xml" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(res.headers["cache-control"]).toMatch(/no-store/);
      expect(res.body).toMatch(/http-equiv="refresh"/);
      expect(res.body).toMatch(/Starting/i);

      // The wake continued in the background; once up, the same URL serves.
      await new Promise((r) => setTimeout(r, 2000));
      const after = await gw.inject({
        method: "GET",
        url: "/dashboard?tab=1",
        headers: { host, cookie, accept: "text/html" },
      });
      expect(after.statusCode).toBe(200);
      expect(runtime.starts).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it("non-HTML requests get 503 with Retry-After when the wake budget runs out", async () => {
    runtime.startDelayMs = 1500;
    const gw = await gatewayWith({ wakeBudgetMs: 200 });
    try {
      const res = await gw.inject({
        method: "POST",
        url: "/api/items",
        headers: { host, cookie, accept: "application/json", "content-type": "application/json" },
        payload: { a: 1 },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(res.json()).toMatchObject({ code: "INTERNAL" });
    } finally {
      await gw.close();
    }
  });

  it("an app stopped behind a stale 'running' status is woken on proxy failure", async () => {
    await dbBundle.db
      .update(schema.apps)
      .set({ status: "running" })
      .where(eq(schema.apps.id, appId));
    const gw = await gatewayWith({ htmlHoldMs: 100 });
    try {
      const first = await gw.inject({
        method: "GET",
        url: "/",
        headers: { host, cookie, accept: "text/html" },
      });
      expect(first.statusCode).toBe(503);
      expect(first.body).toMatch(/http-equiv="refresh"/);
      await new Promise((r) => setTimeout(r, 1000));
      const second = await gw.inject({
        method: "GET",
        url: "/",
        headers: { host, cookie, accept: "text/html" },
      });
      expect(second.statusCode).toBe(200);
      expect(runtime.starts).toBe(1);
    } finally {
      await gw.close();
    }
  });

  it("touches the app (debounced) so traffic keeps it awake", async () => {
    const gw = await gatewayWith({});
    try {
      for (let i = 0; i < 5; i++) {
        const res = await gw.inject({
          method: "GET",
          url: "/",
          headers: { host, cookie, accept: "application/json" },
        });
        expect(res.statusCode).toBe(200);
      }
      await new Promise((r) => setTimeout(r, 100));
      expect(touchCalls).toBe(1);
      const [m] = await dbBundle.db
        .select()
        .from(schema.machines)
        .where(eq(schema.machines.appId, appId));
      expect(Date.now() - (m?.lastRequestAt?.getTime() ?? 0)).toBeLessThan(10_000);
    } finally {
      await gw.close();
    }
  });
});
