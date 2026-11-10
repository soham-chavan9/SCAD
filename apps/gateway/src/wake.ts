import { connect } from "node:net";
import type { ResolvedApp } from "./resolve.js";

/** §14: hold a request up to 15 s while a stopped app starts. */
export const WAKE_BUDGET_MS = 15_000;
/** HTML navigations get the self-retrying wait page after this short hold. */
export const HTML_HOLD_MS = 3_000;
/** At most one touch per app per window (§9 step 8 "debounced"). */
export const TOUCH_DEBOUNCE_MS = 30_000;
/** Matches the resolve cache TTL: a stale "stopped" status is ignored this long after a wake. */
const AWAKE_MEMO_MS = 30_000;

/** Gateway → control plane machine calls (§8 internal routes). */
export type MachineClient = {
  wake(appId: string): Promise<void>;
  touch(appId: string, userId: string): Promise<void>;
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
    touch: (appId, userId) => post("/internal/touch", { appId, userId }),
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
  readonly #touchedAt = new Map<string, number>();

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

  /** Fire-and-forget, at most once per app per debounce window. */
  touch(appId: string, userId: string): void {
    const now = Date.now();
    const last = this.#touchedAt.get(appId);
    if (last !== undefined && now - last < TOUCH_DEBOUNCE_MS) return;
    this.#touchedAt.set(appId, now);
    this.#client.touch(appId, userId).catch(() => {
      this.#touchedAt.delete(appId);
    });
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
