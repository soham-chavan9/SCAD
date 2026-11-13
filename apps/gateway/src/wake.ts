import { connect } from "node:net";
import type { ResolvedApp } from "./resolve.js";

/** §14: hold a request up to 15 s while a stopped app starts. */
export const WAKE_BUDGET_MS = 15_000;
/** HTML navigations get the self-retrying wait page after this short hold. */
export const HTML_HOLD_MS = 3_000;
/** At most one touch per viewer per app per window (§9 step 8 "debounced"); later requests are counted and sent at the window's end. */
export const TOUCH_DEBOUNCE_MS = 30_000;
/** Matches the resolve cache TTL: a stale "stopped" status is ignored this long after a wake. */
const AWAKE_MEMO_MS = 30_000;

/** Gateway → control plane machine calls (§8 internal routes). */
export type MachineClient = {
  wake(appId: string): Promise<void>;
  /** `requests`: how many requests this touch stands for (debounced ones included). */
  /** `userId` is null for anonymous visitors of a public site (T3.5): counted, not as a viewer. */
  touch(appId: string, userId: string | null, requests: number): Promise<void>;
};

export function createHttpMachineClient(opts: {
  controlPlaneUrl: string;
  internalSecret: string;
  fetchImpl?: typeof fetch;
}): MachineClient {
  const doFetch = opts.fetchImpl ?? fetch;
  async function post(path: string, body: unknown): Promise<void> {
    const res = await doFetch(new URL(path, opts.controlPlaneUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scad-internal-secret": opts.internalSecret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const envelope = (await res.json().catch(() => null)) as { code?: string } | null;
      throw new Error(`${path} failed: ${res.status} ${envelope?.code ?? ""}`.trim());
    }
  }
  return {
    wake: (appId) => post("/internal/wake", { appId }),
    touch: (appId, userId, requests) =>
      post("/internal/touch", { appId, ...(userId ? { userId } : {}), requests }),
  };
}

export type HoldOutcome = "ready" | "pending" | "failed";

/** Resolve once host:port accepts a TCP connection, or reject at the deadline. */
export async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(1000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    if (ok) return;
    if (Date.now() >= deadline) {
      throw new Error(`app did not accept connections on ${host}:${port}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Wake-on-request (§9 step 6). Concurrent requests for one app share a single
 * in-flight wake, so a storm of requests causes one control-plane wake and one
 * start. The control plane is single-flight too, for multiple gateways.
 */
export class WakeCoordinator {
  readonly #client: MachineClient;
  readonly #readyTimeoutMs: number;
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #awakeAt = new Map<string, number>();
  /** Open debounce windows, keyed by app and viewer; `pending` counts requests not yet sent. */
  readonly #touchWindows = new Map<string, { pending: number }>();

  constructor(opts: { client: MachineClient; readyTimeoutMs?: number }) {
    this.#client = opts.client;
    this.#readyTimeoutMs = opts.readyTimeoutMs ?? WAKE_BUDGET_MS;
  }

  needsWake(app: ResolvedApp): boolean {
    if (app.status !== "stopped") return false;
    const at = this.#awakeAt.get(app.appId);
    return at === undefined || Date.now() - at > AWAKE_MEMO_MS;
  }

  /** The upstream refused a connection: forget that we think it is awake. */
  markAsleep(appId: string): void {
    this.#awakeAt.delete(appId);
  }

  /** Start (or join) the wake for an app. Resolves when its port accepts connections. */
  wake(appId: string, target: { host: string; port: number }): Promise<void> {
    const existing = this.#inflight.get(appId);
    if (existing) return existing;
    const p = (async () => {
      await this.#client.wake(appId);
      await waitForPort(target.host, target.port, this.#readyTimeoutMs);
      this.#awakeAt.set(appId, Date.now());
    })();
    this.#inflight.set(appId, p);
    // Nobody may be awaiting (an HTML hold can return first); never leave an unhandled rejection.
    p.catch(() => undefined).finally(() => this.#inflight.delete(appId));
    return p;
  }

  /** Wait up to `ms` for a wake. `pending` means it is still going in the background. */
  async hold(wake: Promise<void>, ms: number): Promise<HoldOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<HoldOutcome>((resolve) => {
      timer = setTimeout(() => resolve("pending"), ms);
    });
    try {
      return await Promise.race([
        wake.then(
          (): HoldOutcome => "ready",
          (): HoldOutcome => "failed",
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fire-and-forget usage + keep-awake signal. The first request from a viewer
   * is sent at once; further requests from that viewer within the debounce
   * window are counted and sent as one touch when the window closes, so every
   * viewer and every request reaches the usage counters (§9 step 8).
   */
  touch(appId: string, userId: string | null): void {
    const key = `${appId} ${userId ?? "anonymous"}`;
    const open = this.#touchWindows.get(key);
    if (open) {
      open.pending += 1;
      return;
    }
    const window = { pending: 0 };
    this.#touchWindows.set(key, window);
    this.#sendTouch(appId, userId, 1);
    const timer = setTimeout(() => {
      this.#touchWindows.delete(key);
      if (window.pending > 0) this.#sendTouch(appId, userId, window.pending);
    }, TOUCH_DEBOUNCE_MS);
    timer.unref();
  }

  #sendTouch(appId: string, userId: string | null, requests: number): void {
    // Best effort: a lost touch only undercounts usage; the next window retries keep-awake.
    this.#client.touch(appId, userId, requests).catch(() => undefined);
  }
}

/** Browser page loads (not fetch/XHR) get the wait page instead of a held request. */
export function isHtmlNavigation(req: {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (req.headers["sec-fetch-mode"] === "navigate") return true;
  const accept = req.headers["accept"];
  return typeof accept === "string" && accept.includes("text/html");
}

const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** True when the proxy never reached the app (stopped container), not an app-level error. */
export function isConnectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
