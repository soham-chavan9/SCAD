/**
 * In-memory sliding-window limiter. One gateway process per instance (D6),
 * so memory is enough; a restart only resets the windows.
 */
export class SlidingWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(opts: { limit: number; windowMs: number }) {
    this.#limit = opts.limit;
    this.#windowMs = opts.windowMs;
  }

  /** Record a hit for `key`; returns false if it is over the limit (the hit is not recorded). */
  take(key: string, now: Date): boolean {
    const t = now.getTime();
    const since = t - this.#windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((h) => h > since);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.#hits.set(key, recent);
    if (this.#hits.size > 10_000) this.#prune(since);
    return true;
  }

  #prune(since: number): void {
    for (const [key, hits] of this.#hits) {
      if (hits.every((h) => h <= since)) this.#hits.delete(key);
    }
  }
}

export const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;
export const MAGIC_LINK_PER_EMAIL = 5;
export const MAGIC_LINK_PER_IP = 20;
