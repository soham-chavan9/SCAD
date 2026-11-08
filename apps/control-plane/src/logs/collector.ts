import { eq } from "drizzle-orm";
import type { RuntimeProvider } from "@scad/runtime-conformance";
import type { Db } from "../db/client.js";
import { machines } from "../db/schema.js";
import { appendRuntimeLogs, hasContainerLogs, type RuntimeLogInsert } from "./runtime-log-store.js";

/** How far back to read a container the store has never seen (its whole recent log). */
const NEW_CONTAINER_TAIL = 10_000;
/** Shorter values are too likely to match ordinary text to redact safely. */
const MIN_REDACT_LENGTH = 6;

export type RuntimeLogCollectorOpts = {
  db: Db["db"];
  runtime: RuntimeProvider;
  /** Secret env values of the app, redacted from every stored line (INV12). */
  secretsFor?: (appId: string) => Promise<string[]>;
  flushMs?: number;
  /** Per-app cap per flush window; the rest is counted and stored as one line. */
  maxLinesPerFlush?: number;
  onError?: (err: unknown) => void;
};

type Stream = {
  appId: string;
  providerId: string;
  secrets: string[];
  pending: RuntimeLogInsert[];
  dropped: number;
  /** Set when closed or replaced; later lines are ignored. */
  stopped: boolean;
  iterator: AsyncIterator<string>;
  done: Promise<void>;
};

/**
 * Copies app stdout/stderr from the runtime into SCAD's `runtime_logs` store,
 * one follow stream per running app. Docker keeps only a small rotating
 * buffer; this store is what `scad logs` reads and what the 7-day job deletes.
 */
export class RuntimeLogCollector {
  readonly #db: Db["db"];
  readonly #runtime: RuntimeProvider;
  readonly #secretsFor: ((appId: string) => Promise<string[]>) | undefined;
  readonly #maxLines: number;
  readonly #onError: (err: unknown) => void;
  readonly #streams = new Map<string, Stream>();
  /** Streams that ended but may still hold unflushed lines. */
  readonly #ended: Stream[] = [];
  readonly #attaching = new Map<string, Promise<void>>();
  readonly #timer: NodeJS.Timeout;
  #flushing: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(opts: RuntimeLogCollectorOpts) {
    this.#db = opts.db;
    this.#runtime = opts.runtime;
    this.#secretsFor = opts.secretsFor;
    this.#maxLines = opts.maxLinesPerFlush ?? 2000;
    this.#onError = opts.onError ?? (() => undefined);
    this.#timer = setInterval(() => void this.flush(), opts.flushMs ?? 250);
    this.#timer.unref();
  }

  isCollecting(appId: string): boolean {
    return this.#streams.has(appId);
  }

  /**
   * Start collecting the app's container. A container with nothing stored yet
   * is read from its start; one already stored resumes with new lines only.
   */
  attach(appId: string, providerId: string): Promise<void> {
    if (this.#closed || !providerId) return Promise.resolve();
    if (this.#streams.get(appId)?.providerId === providerId) return Promise.resolve();
    const inFlight = this.#attaching.get(appId);
    if (inFlight) return inFlight;
    const p = this.#doAttach(appId, providerId).finally(() => this.#attaching.delete(appId));
    this.#attaching.set(appId, p);
    return p;
  }

  /** Attach to every running machine without a stream (startup, builder deploys, restarts). */
  async sweep(): Promise<void> {
    const rows = await this.#db
      .select({ appId: machines.appId, providerId: machines.providerId })
      .from(machines)
      .where(eq(machines.state, "running"));
    for (const row of rows) {
      if (this.#streams.get(row.appId)?.providerId === row.providerId) continue;
      await this.attach(row.appId, row.providerId).catch((err: unknown) => this.#onError(err));
    }
  }

  /** Write buffered lines. Calls are serialized. */
  flush(): Promise<void> {
    this.#flushing = this.#flushing.then(() => this.#doFlush()).catch((err: unknown) => this.#onError(err));
    return this.#flushing;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await Promise.all([...this.#attaching.values()].map((p) => p.catch(() => undefined)));
    // A follow stream blocked on a quiet container only ends on its next line,
    // so stop listening instead of waiting for it.
    for (const s of this.#streams.values()) {
      this.#stop(s);
      this.#ended.push(s); // its buffered lines still get flushed below
    }
    this.#streams.clear();
    await this.flush();
  }

  async #doAttach(appId: string, providerId: string): Promise<void> {
    const previous = this.#streams.get(appId);
    if (previous) {
      this.#stop(previous);
      this.#streams.delete(appId);
      this.#ended.push(previous);
    }
    const known = await hasContainerLogs(this.#db, appId, providerId);
    const secrets = ((await this.#secretsFor?.(appId)) ?? [])
      .filter((v) => v.length >= MIN_REDACT_LENGTH)
      .sort((a, b) => b.length - a.length);
    const lines = this.#runtime.logs(
      { appId, providerId },
      { follow: true, tail: known ? 0 : NEW_CONTAINER_TAIL },
    );
    const stream: Stream = {
      appId,
      providerId,
      secrets,
      pending: [],
      dropped: 0,
      stopped: false,
      iterator: lines[Symbol.asyncIterator](),
      done: Promise.resolve(),
    };
    this.#streams.set(appId, stream);
    stream.done = this.#pump(stream);
  }

  async #pump(stream: Stream): Promise<void> {
    try {
      for (;;) {
        const next = await stream.iterator.next();
        if (next.done) break;
        this.#buffer(stream, next.value);
      }
    } catch (err) {
      this.#onError(err);
    } finally {
      if (this.#streams.get(stream.appId) === stream) {
        this.#streams.delete(stream.appId);
        this.#ended.push(stream);
      }
    }
  }

  #stop(stream: Stream): void {
    stream.stopped = true;
    void stream.iterator.return?.();
  }

  #buffer(stream: Stream, raw: string): void {
    if (stream.stopped) return;
    if (stream.pending.length >= this.#maxLines) {
      stream.dropped += 1;
      return;
    }
    let line = raw;
    for (const secret of stream.secrets) line = line.replaceAll(secret, "[redacted]");
    stream.pending.push({ appId: stream.appId, providerId: stream.providerId, line });
  }

  async #doFlush(): Promise<void> {
    const streams = [...this.#streams.values(), ...this.#ended.splice(0)];
    const rows: RuntimeLogInsert[] = [];
    for (const s of streams) {
      rows.push(...s.pending.splice(0));
      if (s.dropped > 0) {
        rows.push({
          appId: s.appId,
          providerId: s.providerId,
          line: `[scad] ${s.dropped} log lines dropped (over ${this.#maxLines} lines per flush)`,
        });
        s.dropped = 0;
      }
    }
    await appendRuntimeLogs(this.#db, rows);
  }
}

/** Sweep now and on an interval (default 5 s) so new deploys and restarts are picked up. */
export function startRuntimeLogCollection(
  collector: RuntimeLogCollector,
  opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    collector
      .sweep()
      .catch((err: unknown) => opts.onError?.(err))
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, opts.intervalMs ?? 5000);
  timer.unref();
  return () => clearInterval(timer);
}
