import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertTruncateAllowed,
  buildApp as buildControlPlane,
  createDb,
  issuePat,
  runMigrations,
  schema,
  type Db,
} from "@scad/control-plane";
import {
  appHost,
  authHost,
  buildGateway,
  FakeIdentityProvider,
  generateEphemeralIdentityKeys,
  issueLoginCode,
  LOGIN_CODE_TTL_MS,
  MemoryMailer,
  SESSION_COOKIE,
  type AppResolver,
  type ResolvedApp,
} from "@scad/gateway";

const databaseUrl = process.env["DATABASE_URL"];
const BASE_DOMAIN = "localhost:8080";
const INTERNAL_SECRET = "adv-identity-secret";

/**
 * T2.8: a hostile browser or client against the real gateway and control
 * plane (no Docker needed). Each test names its invariant (AGENTS §12).
 */
describe.runIf(Boolean(databaseUrl))(
  "identity, sessions, and ownership under attack (T2.8)",
  () => {
    let dbBundle: Db;
    let controlPlane: Awaited<ReturnType<typeof buildControlPlane>>;
    let gateway: Awaited<ReturnType<typeof buildGateway>>;
    let upstream: Server;
    let upstreamPort: number;
    let alice: { id: string; pat: string };
    let mallory: { id: string; pat: string };
    let appA: string;
    const hostA = appHost("board", "alice", BASE_DOMAIN);
    const hostB = appHost("notes", "alice", BASE_DOMAIN);
    const auth = authHost(BASE_DOMAIN);

    const get = (host: string, headers: Record<string, string> = {}) =>
      gateway.inject({ method: "GET", url: "/", headers: { host, ...headers } });

    /** A real session for `userId` on `host`, obtained the way a browser does: login code -> callback. */
    async function sessionCookie(userId: string, host: string): Promise<string> {
      const code = await issueLoginCode(dbBundle.db, { userId, appHost: host });
      const res = await gateway.inject({
        method: "GET",
        url: `/__scad/callback?code=${encodeURIComponent(code)}&return_to=%2F`,
        headers: { host },
      });
      expect(res.statusCode).toBe(302);
      const set = String(res.headers["set-cookie"]);
      expect(set.toLowerCase()).not.toContain("domain=");
      return /scad_session=([^;]+)/.exec(set)![1]!;
    }

    async function userWithPat(email: string, handle: string) {
      const [u] = await dbBundle.db.insert(schema.users).values({ email, handle }).returning();
      const pat = issuePat();
      await dbBundle.db
        .insert(schema.pats)
        .values({ userId: u!.id, tokenHash: pat.tokenHash, name: "t" });
      return { id: u!.id, pat: pat.token };
    }

    beforeAll(async () => {
      if (!databaseUrl) throw new Error("DATABASE_URL required");
      assertTruncateAllowed(databaseUrl);
      await runMigrations(databaseUrl);
      dbBundle = createDb(databaseUrl);
      await dbBundle.client.unsafe(
        "TRUNCATE TABLE invites, runtime_logs, env_vars, app_access, magic_links, oauth_states, login_codes, " +
          "sessions, audit_events, machines, releases, pats, apps, users RESTART IDENTITY CASCADE",
      );
      alice = await userWithPat("alice@example.com", "alice");
      mallory = await userWithPat("mallory@example.com", "mallory");
      const [a] = await dbBundle.db
        .insert(schema.apps)
        .values([
          { slug: "board", ownerId: alice.id, status: "running" },
          { slug: "notes", ownerId: alice.id, status: "running" },
        ])
        .returning();
      appA = a!.id;

      // The "app": echoes every X-SCAD-* header it received.
      upstream = createServer((req, res) => {
        const scad = Object.fromEntries(
          Object.entries(req.headers).filter(([k]) => k.startsWith("x-scad-")),
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(scad));
      });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
      upstreamPort = (upstream.address() as { port: number }).port;

      controlPlane = await buildControlPlane({
        db: dbBundle.db,
        internalSecret: INTERNAL_SECRET,
        internalToken: "adv-identity-token",
        baseDomain: BASE_DOMAIN,
        masterKeys: { current: randomBytes(32), previous: [] },
      });
      const resolver: AppResolver = {
        async resolve(h) {
          const res = await controlPlane.inject({
            method: "POST",
            url: "/internal/resolve",
            headers: { "x-scad-internal-secret": INTERNAL_SECRET },
            payload: { host: h },
          });
          if (res.statusCode === 404) return null;
          return { ...(res.json() as ResolvedApp), upstreamHost: "127.0.0.1", port: upstreamPort };
        },
      };
      gateway = await buildGateway({
        db: dbBundle.db,
        baseDomain: BASE_DOMAIN,
        identity: new FakeIdentityProvider(),
        resolver,
        keys: await generateEphemeralIdentityKeys(),
        mailer: new MemoryMailer(),
      });
      await gateway.ready();
    });

    afterAll(async () => {
      await gateway?.close();
      await controlPlane?.close();
      await dbBundle?.client.end({ timeout: 5 });
      await new Promise<void>((r) => upstream?.close(() => r()));
    });

    describe("spoofing identity headers", () => {
      it("INV3: forged X-SCAD-* headers are stripped and replaced by the gateway's own", async () => {
        const cookie = await sessionCookie(alice.id, hostA);
        const res = await get(hostA, {
          cookie: `${SESSION_COOKIE}=${cookie}`,
          "x-scad-user-email": "ceo@example.com",
          "x-scad-user-id": mallory.id,
          "X-SCAD-User-Name": "CEO",
          "x-scad-identity": "eyJhbGciOiJub25lIn0.eyJzdWIiOiJjZW8ifQ.",
          "x-scad-admin": "true",
        });
        expect(res.statusCode).toBe(200);
        const seen = res.json() as Record<string, string>;
        expect(seen["x-scad-user-email"]).toBe("alice@example.com");
        expect(seen["x-scad-user-id"]).toBe(alice.id);
        expect(seen["x-scad-user-name"]).not.toBe("CEO");
        expect(seen["x-scad-identity"]).not.toContain("eyJhbGciOiJub25lIn0");
        expect(seen["x-scad-admin"]).toBeUndefined();
      });

      it("INV3: an unauthenticated request with forged headers never reaches the app", async () => {
        const res = await get(hostA, {
          "x-scad-user-email": "alice@example.com",
          "x-scad-user-id": alice.id,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain(`//${auth}/login`);
      });
    });

    describe("forging or replaying cookies", () => {
      it("INV4: a made-up session cookie is rejected", async () => {
        const res = await get(hostA, {
          cookie: `${SESSION_COOKIE}=00000000-0000-4000-8000-000000000000`,
        });
        expect(res.statusCode).toBe(302);
        const junk = await get(hostA, { cookie: `${SESSION_COOKIE}=' OR 1=1 --` });
        expect(junk.statusCode).toBe(302);
      });

      it("INV4: a valid cookie for app A is not valid for app B (host-only, host-bound)", async () => {
        const cookie = await sessionCookie(alice.id, hostA);
        expect((await get(hostA, { cookie: `${SESSION_COOKIE}=${cookie}` })).statusCode).toBe(200);
        expect((await get(hostB, { cookie: `${SESSION_COOKIE}=${cookie}` })).statusCode).toBe(302);
      });

      it("INV4: a revoked session cookie replayed later is rejected", async () => {
        const cookie = await sessionCookie(alice.id, hostA);
        await dbBundle.client`UPDATE sessions SET revoked_at = now() WHERE id = ${cookie}`;
        expect((await get(hostA, { cookie: `${SESSION_COOKIE}=${cookie}` })).statusCode).toBe(302);
      });

      it("INV4: an expired session cookie is rejected", async () => {
        const cookie = await sessionCookie(alice.id, hostA);
        await dbBundle.client`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${cookie}`;
        expect((await get(hostA, { cookie: `${SESSION_COOKIE}=${cookie}` })).statusCode).toBe(302);
      });
    });

    describe("forging or replaying login codes", () => {
      const callback = (host: string, code: string) =>
        gateway.inject({
          method: "GET",
          url: `/__scad/callback?code=${encodeURIComponent(code)}&return_to=%2F`,
          headers: { host },
        });

      it("INV5: a login code works once; replaying it fails", async () => {
        const code = await issueLoginCode(dbBundle.db, { userId: alice.id, appHost: hostA });
        expect((await callback(hostA, code)).statusCode).toBe(302);
        const replay = await callback(hostA, code);
        expect(replay.statusCode).toBe(400);
        expect(replay.headers["set-cookie"]).toBeUndefined();
      });

      it("INV5: a login code for app A cannot be spent on app B", async () => {
        const code = await issueLoginCode(dbBundle.db, { userId: alice.id, appHost: hostA });
        const res = await callback(hostB, code);
        expect(res.statusCode).toBe(400);
        expect(res.headers["set-cookie"]).toBeUndefined();
      });

      it("INV5: an expired login code fails", async () => {
        const code = await issueLoginCode(dbBundle.db, {
          userId: alice.id,
          appHost: hostA,
          now: new Date(Date.now() - LOGIN_CODE_TTL_MS - 1000),
        });
        expect((await callback(hostA, code)).statusCode).toBe(400);
      });

      it("INV5: a guessed login code fails", async () => {
        expect((await callback(hostA, "a".repeat(32))).statusCode).toBe(400);
      });

      it("INV5: login codes are stored hashed, never as the code itself", async () => {
        const code = await issueLoginCode(dbBundle.db, { userId: alice.id, appHost: hostA });
        const rows = await dbBundle.client<
          { code_hash: string }[]
        >`SELECT code_hash FROM login_codes`;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((r) => r.code_hash === code)).toBe(false);
        expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash))).toBe(true);
      });
    });

    describe("another user's app through the API", () => {
      const asMallory = (
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        url: string,
        payload?: object,
      ) =>
        controlPlane.inject({
          method,
          url,
          headers: { authorization: `Bearer ${mallory.pat}` },
          ...(payload ? { payload: payload as Record<string, unknown> } : {}),
        });

      it.each([
        ["GET", "/v1/apps/APP", undefined],
        ["GET", "/v1/apps/APP/env", undefined],
        ["PUT", "/v1/apps/APP/env", { STEAL: "1" }],
        ["GET", "/v1/apps/APP/share", undefined],
        ["POST", "/v1/apps/APP/share", { email: "mallory@example.com" }],
        ["PATCH", "/v1/apps/APP", { visibility: "instance" }],
        ["GET", "/v1/apps/APP/logs", undefined],
        ["DELETE", "/v1/apps/APP", undefined],
      ] as const)(
        "INV10: %s %s on someone else's app is NOT_FOUND",
        async (method, path, payload) => {
          const res = await asMallory(method, path.replace("APP", appA), payload);
          expect(res.statusCode).toBe(404);
          expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
        },
      );

      it("INV10: nothing changed on alice's app", async () => {
        const [row] = await dbBundle.client<{ status: string; visibility: string }[]>`
        SELECT status, visibility FROM apps WHERE id = ${appA}`;
        expect(row).toEqual({ status: "running", visibility: "allowlist" });
        const shares = await dbBundle.client`SELECT 1 FROM app_access WHERE app_id = ${appA}`;
        expect(shares).toHaveLength(0);
      });

      it("INV10 + T2.6: a member cannot use operator routes to suspend someone else's app", async () => {
        const res = await asMallory("POST", `/v1/admin/apps/${appA}/suspend`);
        expect(res.statusCode).toBe(403);
      });
    });
  },
);
