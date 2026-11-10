import type { ErrorEnvelope } from "@scad/shared";

export type ScadClientOptions = {
  baseUrl: string;
  pat?: string;
  fetchImpl?: typeof fetch;
};

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
};

export type PublishResponse = {
  app: { id: string; slug: string; ownerId: string; status: string };
  release: { id: string; version: number; status: string };
  url: string;
};

export type ReleaseStatus = {
  id: string;
  appId: string;
  version: number;
  status: "building" | "ready" | "failed";
  imageRef: string;
  error: ErrorEnvelope | null;
  log_tail: string[];
};

export type AppSummary = {
  id: string;
  slug: string;
  ownerId: string;
  status: string;
  visibility: string;
  createdAt: string;
  expiresAt: string | null;
  lastViewedAt: string | null;
  url: string;
};

export type AppShares = {
  app_id: string;
  visibility: "allowlist" | "instance";
  viewers: { email: string; granted_at: string }[];
};

export class ScadApiError extends Error {
  readonly status: number;
  readonly envelope: ErrorEnvelope | { error: string };

  constructor(status: number, envelope: ErrorEnvelope | { error: string }) {
    super("message" in envelope ? envelope.message : envelope.error);
    this.name = "ScadApiError";
    this.status = status;
    this.envelope = envelope;
  }
}

export class ScadClient {
  readonly baseUrl: string;
  pat: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(opts: ScadClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.pat = opts.pat;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async startDeviceAuth(): Promise<DeviceCodeResponse> {
    return this.#json("/v1/auth/device", { method: "POST" });
  }

  async pollDeviceToken(
    deviceCode: string,
  ): Promise<{ pat: string } | { error: "authorization_pending" }> {
    const res = await this.#fetch(`${this.baseUrl}/v1/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    const body = (await res.json()) as { pat?: string; error?: string } & Partial<ErrorEnvelope>;
    if (res.ok && body.pat) {
      return { pat: body.pat };
    }
    if (body.error === "authorization_pending") {
      return { error: "authorization_pending" };
    }
    throw new ScadApiError(res.status, body as ErrorEnvelope);
  }

  async approveDevice(userCode: string, email: string): Promise<void> {
    await this.#json("/v1/auth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_code: userCode, email }),
    });
  }

  async publish(opts: {
    tarball: Buffer;
    name?: string;
    manifest?: unknown;
  }): Promise<PublishResponse> {
    const form = new FormData();
    form.append("tarball", new Blob([new Uint8Array(opts.tarball)]), "app.tar");
    if (opts.name !== undefined) {
      form.append("name", opts.name);
    }
    if (opts.manifest !== undefined) {
      form.append("manifest", JSON.stringify(opts.manifest));
    }
    return this.#json("/v1/apps/publish", {
      method: "POST",
      body: form,
      auth: true,
    });
  }

  async getRelease(id: string): Promise<ReleaseStatus> {
    return this.#json(`/v1/releases/${id}`, { method: "GET", auth: true });
  }

  async listApps(): Promise<{ apps: AppSummary[] }> {
    return this.#json("/v1/apps", { method: "GET", auth: true });
  }

  async getApp(idOrSlug: string): Promise<{ app: AppSummary }> {
    return this.#json(`/v1/apps/${encodeURIComponent(idOrSlug)}`, {
      method: "GET",
      auth: true,
    });
  }

  async shareApp(idOrSlug: string, email: string): Promise<{ app_id: string; email: string }> {
    return this.#json(`/v1/apps/${encodeURIComponent(idOrSlug)}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      auth: true,
    });
  }

  async unshareApp(
    idOrSlug: string,
    email: string,
  ): Promise<{ app_id: string; email: string; removed: boolean }> {
    return this.#json(
      `/v1/apps/${encodeURIComponent(idOrSlug)}/share/${encodeURIComponent(email)}`,
      { method: "DELETE", auth: true },
    );
  }

  async listShares(idOrSlug: string): Promise<AppShares> {
    return this.#json(`/v1/apps/${encodeURIComponent(idOrSlug)}/share`, {
      method: "GET",
      auth: true,
    });
  }

  async setVisibility(
    idOrSlug: string,
    visibility: "allowlist" | "instance",
  ): Promise<{ app: { id: string; slug: string; visibility: "allowlist" | "instance" } }> {
    return this.#json(`/v1/apps/${encodeURIComponent(idOrSlug)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility }),
      auth: true,
    });
  }

  async #json<T>(
    path: string,
    init: RequestInit & { auth?: boolean },
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.auth) {
      if (!this.pat) {
        throw new Error("Not logged in; run scad login");
      }
      headers.set("authorization", `Bearer ${this.pat}`);
    }
    const res = await this.#fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = (await res.json()) as T | ErrorEnvelope;
    if (!res.ok) {
      throw new ScadApiError(res.status, body as ErrorEnvelope);
    }
    return body as T;
  }
}
