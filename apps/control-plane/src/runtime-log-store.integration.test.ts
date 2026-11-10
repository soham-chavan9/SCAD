import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  DeploySpec,
  MachineRef,
  MachineStatus,
  Reachable,
  RuntimeProvider,
} from "@scad/runtime-conformance";
import { createDb, type Db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { apps, machines, runtimeLogs, users } from "./db/schema.js";
import { assertTruncateAllowed } from "./db/test-db.js";
import { RuntimeLogCollector } from "./logs/collector.js";
import { appendRuntimeLogs, pruneRuntimeLogs, recentRuntimeLogs } from "./logs/runtime-log-store.js";
import { LOG_RETENTION_MS } from "./log-retention.js";

const databaseUrl = process.env["DATABASE_URL"];
const DAY = 24 * 60 * 60 * 1000;

/** Runtime whose log stream is fed by the test. */
class FeedRuntime implements RuntimeProvider {
  calls: { providerId: string; follow: boolean; tail?: number }[] = [];
  #feeds = new Map<string, { lines: string[]; wake?: () => void; ended: boolean }>();

  feed(providerId: string, ...lines: string[]): void {
    const f = this.#feed(providerId);
    f.lines.push(...lines);
    f.wake?.();
  }
  end(providerId: string): void {
    const f = this.#feed(providerId);
    f.ended = true;
    f.wake?.();
  }
  #feed(providerId: string) {
    let f = this.#feeds.get(providerId);
    if (!f) {
      f = { lines: [], ended: false };
      this.#feeds.set(providerId, f);
    }
    return f;
  }

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
  async *logs(m: MachineRef, opts: { follow: boolean; tail?: number }): AsyncIterable<string> {
    this.calls.push({ providerId: m.providerId, ...opts });
    const f = this.#feed(m.providerId);
    for (;;) {
      while (f.lines.length) yield f.lines.shift()!;
      if (f.ended || !opts.follow) return;
      await new Promise<void>((r) => (f.wake = r));
    }
  }
  async remove(): Promise<void> {}
}

async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.runIf(Boolean(databaseUrl))("runtime log store (T1.7b)", () => {
  let dbBundle: Db;
  let appId: string;

  const storedLines = async (id = appId) =>
    (
      await dbBundle.db.execute<{ line: string }>(
        sql`SELECT line FROM runtime_logs WHERE app_id = ${id} ORDER BY id`,
      )
    ).map((r) => r.line);

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
  });

  beforeEach(async () => {
    await dbBundle.db.execute(sql`
      TRUNCATE TABLE
        runtime_logs, env_vars, app_access, magic_links, oauth_states, login_codes, sessions, audit_events, machines, releases, pats, apps, users
      RESTART IDENTITY CASCADE
    `);
    const [u] = await dbBundle.db.insert(users).values({ email: "o@example.com", handle: "o" }).returning();
    const [a] = await dbBundle.db
      .insert(apps)
      .values({ slug: "log-store", ownerId: u!.id, status: "running" })
      .returning();
    appId = a!.id;
    await dbBundle.db.insert(machines).values({ appId, providerId: "c1", state: "running" });
  });

  afterAll(async () => {
    await dbBundle?.client.end({ timeout: 5 });
  });

  it("the retention job deletes rows older than 7 days from storage", async () => {
    const now = new Date("2026-11-08T12:00:00Z");
    await appendRuntimeLogs(dbBundle.db, [
      { appId, providerId: "c1", line: "ancient", at: new Date(now.getTime() - LOG_RETENTION_MS - 60_000) },
      { appId, providerId: "c1", line: "recent", at: new Date(now.getTime() - 6 * DAY) },
    ]);

    const result = await pruneRuntimeLogs(dbBundle.db, now);

    expect(result.deleted).toBe(1);
    // Read the table directly: the old row is gone, not just hidden from readers.
    const [count] = await dbBundle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM runtime_logs WHERE line = 'ancient'`,
    );
    expect(count!.n).toBe(0);
    expect(await storedLines()).toEqual(["recent"]);
  });

  it("collects a new container's output from the start, redacting secret values", async () => {
    const runtime = new FeedRuntime();
    const collector = new RuntimeLogCollector({
      db: dbBundle.db,
      runtime,
      flushMs: 20,
      secretsFor: async () => ["s3cr3t-value-123"],
    });
    try {
      runtime.feed("c1", "booting", "api key is s3cr3t-value-123 ok");
      await collector.attach(appId, "c1");
      runtime.feed("c1", "live line");
      await until(async () => (await storedLines()).includes("live line"));

      const lines = await storedLines();
      expect(lines).toEqual(["booting", "api key is [redacted] ok", "live line"]);
      expect(lines.join("\n")).not.toContain("s3cr3t-value-123");
      // Nothing stored for this container yet, so it read the whole container log.
      expect(runtime.calls[0]).toMatchObject({ providerId: "c1", follow: true, tail: 10_000 });
    } finally {
      await collector.close();
    }
  });

  it("resumes a container it already stored without duplicating old lines", async () => {
    await appendRuntimeLogs(dbBundle.db, [{ appId, providerId: "c1", line: "from before" }]);
    const runtime = new FeedRuntime();
    const collector = new RuntimeLogCollector({ db: dbBundle.db, runtime, flushMs: 20 });
    try {
      await collector.attach(appId, "c1");
      runtime.feed("c1", "after restart");
      await until(async () => (await storedLines()).includes("after restart"));
      expect(runtime.calls[0]).toMatchObject({ follow: true, tail: 0 });
      expect(await storedLines()).toEqual(["from before", "after restart"]);
    } finally {
      await collector.close();
    }
  });

  it("sweep attaches to running machines and detaches when the stream ends", async () => {
    const runtime = new FeedRuntime();
    const collector = new RuntimeLogCollector({ db: dbBundle.db, runtime, flushMs: 20 });
    try {
      await collector.sweep();
      expect(collector.isCollecting(appId)).toBe(true);
      await collector.sweep();
      expect(runtime.calls).toHaveLength(1); // one stream per app

      runtime.feed("c1", "bye");
      runtime.end("c1");
      await until(async () => !collector.isCollecting(appId));
      await until(async () => (await storedLines()).includes("bye"));
    } finally {
      await collector.close();
    }
  });

  it("caps a flood and records how many lines were dropped", async () => {
    const runtime = new FeedRuntime();
    const collector = new RuntimeLogCollector({ db: dbBundle.db, runtime, flushMs: 50, maxLinesPerFlush: 100 });
    try {
      runtime.feed("c1", ...Array.from({ length: 1000 }, (_, i) => `spam ${i}`));
      runtime.end("c1");
      await collector.attach(appId, "c1");
      await until(async () => !collector.isCollecting(appId));
      await collector.flush();

      const lines = await storedLines();
      expect(lines.filter((l) => l.startsWith("spam "))).toHaveLength(100);
      expect(lines.at(-1)).toMatch(/^\[scad\] 900 log lines dropped/);
    } finally {
      await collector.close();
    }
  });

  it("recentRuntimeLogs returns the last N lines oldest first", async () => {
    await appendRuntimeLogs(
      dbBundle.db,
      ["a", "b", "c", "d"].map((line) => ({ appId, providerId: "c1", line })),
    );
    expect((await recentRuntimeLogs(dbBundle.db, appId, 2)).map((r) => r.line)).toEqual(["c", "d"]);
  });

  it("rows go away with their app", async () => {
    await appendRuntimeLogs(dbBundle.db, [{ appId, providerId: "c1", line: "x" }]);
    await dbBundle.db.delete(machines);
    await dbBundle.db.delete(apps);
    const rows = await dbBundle.db.select().from(runtimeLogs);
    expect(rows).toHaveLength(0);
  });
});
