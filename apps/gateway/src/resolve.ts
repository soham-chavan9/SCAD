export type ResolvedApp = {
  appId: string;
  slug: string;
  status: string;
  expiresAt: string | null;
  ownerId: string;
  ownerHandle: string;
  ownerEmail: string;
  ownerStatus: string;
};

export type AppResolver = {
  resolve(host: string): Promise<ResolvedApp | null>;
};

export function createHttpAppResolver(opts: {
  controlPlaneUrl: string;
  internalSecret: string;
  cacheTtlMs?: number;
}): AppResolver {
  const cache = new Map<string, { value: ResolvedApp | null; expiresAt: number }>();
  const cacheTtlMs = opts.cacheTtlMs ?? 30_000;

  return {
    async resolve(host: string): Promise<ResolvedApp | null> {
      const now = Date.now();
      const cached = cache.get(host);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }

      const res = await fetch(new URL("/internal/resolve", opts.controlPlaneUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scad-internal-secret": opts.internalSecret,
        },
        body: JSON.stringify({ host }),
      });

      if (res.status === 404) {
        cache.set(host, { value: null, expiresAt: now + cacheTtlMs });
        return null;
      }
      if (!res.ok) {
        throw new Error(`resolve failed: ${res.status}`);
      }
      const value = (await res.json()) as ResolvedApp;
      cache.set(host, { value, expiresAt: now + cacheTtlMs });
      return value;
    },
  };
}
