# SCAD: Agent Brief

Read this file fully before writing any code. `TASKS.md` is the ordered build plan. This file is the source of truth for decisions, contracts, and rules. If a task conflicts with this file, stop and ask the human.

---

## 1. What SCAD is

SCAD is a hosting layer for **small software**: tools built by coding agents that have 1 to a few dozen users. A builder runs `scad publish` (or an agent calls the MCP `publish` tool), receives a private URL, and anyone on that app's allowlist can sign in and use it. No servers to set up, no deploy pipeline, no login code in the app.

Analogy for the human reading along: an apartment building. Apps are apartments with thick walls, a doorman checks a guest list, lights go off when nobody is home, and unused apartments are cleared out.

**Core bet:** deployment, not creation, is now the bottleneck for small software. SCAD removes it.

**Core property to protect:** sharing is as easy as a Google Doc. If a change makes publish-then-share slower or more complicated, reject it.

## 2. Locked decisions

| # | Decision |
|---|---|
| D1 | First users: the founder and a few trusted friends (3 to 10 people). Design still assumes **all published code is hostile**. |
| D2 | Apps can be **any runtime, packaged as a container** (Dockerfile in v1; auto-detect in M2). HTTP and WebSocket only. |
| D3 | Sign-in: **GitHub OAuth and email magic link**. Identity layer is a generic OIDC client so Google Workspace, Entra, Okta are config later. |
| D4 | Runtime is behind a `RuntimeProvider` interface. **Docker driver first** (free, local). Fly driver in M3. No provider-specific code outside `packages/runtime-*`. |
| D5 | Local-first development: everything must run on a laptop with Docker, at $0. |
| D6 | Per-app persistent storage is a volume at `/data` (SQLite recommended). Single instance per app. |
| D7 | Outbound network from apps is **denied by default**; only manifest-declared, policy-approved domains via the egress proxy. |
| D8 | Apps expire after 30 days unused (renews on view), 7-day warning, 14-day grace before delete. |
| D9 | One app per hostname: `{slug}.{owner}.{BASE_DOMAIN}`. Local `BASE_DOMAIN=localhost:8080`. |
| D10 | Name is SCAD. CLI binary is `scad`. Manifest is `scad.json`. Identity headers are `X-SCAD-*`. |

## 3. Non-goals (do not build)

Autoscaling or multi-region; public/anonymous apps; custom domains; billing; marketplace or templates; forking UI; per-viewer delegated connectors (Jira, Slack, Drive); org-level environment customization; multi-instance apps; raw TCP; a web dashboard beyond the minimal operator page in M2.

## 4. Architecture

```
 Agent / terminal
    | MCP tool or CLI
    v
 scad CLI + MCP server ---> Control Plane (Fastify API + Postgres)
                               |            |
                  build jobs   |            | RuntimeProvider
                               v            v
                           Builder      Docker driver (v1) / Fly driver (M3)
                               |            |
                               +--> images  +--> per-app container + volume + private network

 Viewer browser --> Gateway (auth, ACL, wake, proxy, header injection)
                          |
                          +--> Identity (OIDC client, magic link, sessions) [served on auth.{BASE_DOMAIN}]
 App containers --(only path out)--> Egress Proxy (per-app allowlist)
```

Services (each a separate process/container): `control-plane`, `gateway`, `builder`, `egress-proxy`. The `gateway` also serves the auth host.

### RuntimeProvider contract (the only way services touch infrastructure)

```ts
export interface DeploySpec {
  appId: string;
  imageRef: string;
  port: number;
  start?: string;
  env: Record<string, string>;      // decrypted just-in-time
  egressAllow: string[];            // approved domains
  limits: { memoryMb: number; cpuShares: number; diskGb: number; pids: number };
}
export interface MachineRef { appId: string; providerId: string }
export interface Reachable { host: string; port: number }   // reachable FROM the gateway only

export interface RuntimeProvider {
  ensureApp(appId: string, diskGb: number): Promise<void>;   // network + volume, idempotent
  deploy(spec: DeploySpec): Promise<MachineRef>;             // replaces running release
  start(m: MachineRef): Promise<void>;
  stop(m: MachineRef): Promise<void>;
  status(m: MachineRef): Promise<'running' | 'stopped' | 'missing'>;
  address(m: MachineRef): Promise<Reachable>;
  logs(m: MachineRef, opts: { follow: boolean; tail?: number }): AsyncIterable<string>;
  remove(appId: string, opts: { deleteVolume: boolean }): Promise<void>;
}
```

A shared conformance test suite in `packages/runtime-conformance` must pass for every driver.

## 5. Tech stack and repo layout

- Node 22, TypeScript (strict), pnpm workspaces, ESM.
- Fastify (HTTP), zod (validation, shared schemas), Drizzle ORM + Postgres, `jose` (JWT, EdDSA), `openid-client` (OIDC), `dockerode` (Docker driver), `commander` (CLI), `@modelcontextprotocol/sdk` (MCP), vitest, eslint, prettier.
- Local services via `docker compose`: Postgres, Mailpit (SMTP catcher), gateway, egress-proxy.

```
apps/control-plane     API, migrations, scheduled jobs
apps/gateway           reverse proxy + auth host
apps/builder           build worker
apps/egress-proxy      CONNECT/HTTP forward proxy with per-app policy
packages/shared        zod schemas, error codes, manifest schema, JWT helpers, types
packages/cli           `scad` binary
packages/mcp-server    MCP tools wrapping the API client
packages/api-client    typed client used by CLI and MCP
packages/runtime-docker
packages/runtime-fly   (M3)
packages/runtime-conformance
tests/e2e              publish -> view flows
tests/adversarial      hostile sample apps + tests
examples/              hello-node, hello-python, hello-static, echo-identity
docs/                  this brief, tasks, threat model, runbook
```

## 6. Local development environment

- `docker compose up -d` starts Postgres, Mailpit, gateway, egress-proxy. Control plane and builder run on the host with `pnpm dev` (they need the Docker socket).
- Hostnames: `*.localhost` resolves to loopback in Chrome and Firefox. Safari may not; fallback is a local dnsmasq or `/etc/hosts` entries. Document this in README.
- Ports: gateway `8080`, control plane `4000`, Mailpit UI `8025`, Postgres `5432`.
- Auth host: `http://auth.localhost:8080`. App host: `http://{slug}.{owner}.localhost:8080`.
- Required env (`.env.example` must list all): `DATABASE_URL`, `BASE_DOMAIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SMTP_URL`, `MASTER_KEY` (32-byte base64), `JWT_PRIVATE_KEY` (Ed25519 PEM), `OPERATOR_EMAILS` (comma list).
- Common commands: `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm test:e2e`, `pnpm test:adversarial`, `pnpm lint`, `pnpm typecheck`, `pnpm db:migrate`.

## 7. Domain model

```
users        id uuid pk, email text unique, display_name, github_id text null, handle text unique,
             role enum(operator|member), status enum(active|suspended), created_at
apps         id uuid pk, slug text, owner_id fk, status enum(building|running|stopped|suspended|expired|deleted),
             visibility enum(allowlist|instance), created_at, last_viewed_at, expires_at, pinned bool default false,
             unique(owner_id, slug)
releases     id uuid pk, app_id fk, version int, image_ref, manifest jsonb, status enum(building|ready|failed),
             build_log_ref, error jsonb null, created_at, unique(app_id, version)
app_access   app_id fk, email text, granted_by fk, created_at, pk(app_id, email)
env_vars     app_id fk, key, value_ciphertext bytea, is_secret bool, pk(app_id, key)
machines     app_id pk fk, provider_id, volume_ref, state, last_started_at, last_request_at
sessions     id uuid pk, user_id fk, created_at, expires_at, revoked_at null
login_codes  code_hash pk, user_id fk, app_host text, expires_at, used_at null        -- one-time gateway codes
magic_links  token_hash pk, email, expires_at, used_at null
pats         id uuid pk, user_id fk, token_hash unique, name, created_at, last_used_at, revoked_at null
audit_events id uuid pk, actor_id fk null, app_id fk null, action text, metadata jsonb, at
usage_daily  app_id fk, day date, requests int, unique_viewers int, egress_bytes bigint, pk(app_id, day)
```

All secrets, tokens, and codes are stored **hashed or encrypted**, never plaintext.

## 8. API contract (control plane, JSON, base `/v1`)

Auth: `Authorization: Bearer <PAT>`. Operator routes require `role=operator`.

```
POST   /auth/device                 -> {device_code, user_code, verification_uri, interval}
POST   /auth/device/token           {device_code} -> {pat} | {error: "authorization_pending"}
POST   /apps/publish                multipart: tarball, manifest? , name? -> 202 {app, release, url}
GET    /releases/:id                -> {status, error?, log_tail}
GET    /releases/:id/logs           SSE build log
GET    /apps                        list mine
GET    /apps/:id                    detail (url, status, expires_at, viewers_30d)
POST   /apps/:id/share              {email}
DELETE /apps/:id/share/:email
PUT    /apps/:id/env                {KEY: value} + {secret?: string[]}
GET    /apps/:id/logs               SSE runtime log
POST   /apps/:id/rollback           (M3)
POST   /apps/:id/transfer           {email} (M3)
DELETE /apps/:id
POST   /admin/users/:id/suspend
POST   /admin/apps/:id/suspend
GET    /admin/usage
```

Internal (gateway to control plane, shared secret + network-restricted): `POST /internal/resolve {host}`, `POST /internal/wake {appId}`, `POST /internal/touch {appId, userId}`.

### Errors (all non-2xx)

```json
{ "code": "BUILD_FAILED", "message": "human readable", "hint": "what the caller should do next", "details": {} }
```

Codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `MANIFEST_INVALID`, `UPLOAD_TOO_LARGE`, `LIMIT_EXCEEDED`, `BUILD_FAILED`, `PORT_NOT_LISTENING`, `SMOKE_CHECK_FAILED`, `APP_SUSPENDED`, `APP_EXPIRED`, `RATE_LIMITED`, `INTERNAL`. Every error an agent could act on must carry a useful `hint` and, for build errors, the last 50 log lines in `details.log_tail`.

## 9. Gateway algorithm

1. Parse `Host`. Resolve app via `/internal/resolve` (cache 30 s). Unknown host: 404 page.
2. No valid host-only session cookie: redirect to `auth.{BASE_DOMAIN}/login?return_to=<app host + path>`.
3. After sign-in, the auth host creates a one-time `login_code` (60 s, bound to the app host) and redirects to `https://{app-host}/__scad/callback?code=...`.
4. Callback exchanges the code, sets a **host-only** cookie (`Secure` outside localhost, `HttpOnly`, `SameSite=Lax`, no `Domain` attribute), redirects to `return_to`.
5. ACL: user active, app not suspended or expired, user email in `app_access` (or visibility rule). Otherwise 403 page.
6. If machine stopped: call `/internal/wake`, hold up to 15 s. For HTML navigations return a self-retrying wait page; for other requests hold or return 503 with `Retry-After`. Concurrent requests for the same app must trigger **one** start.
7. Strip all inbound `X-SCAD-*` headers, then inject identity headers (section 10), proxy to the app's `Reachable` address. Support WebSocket and SSE.
8. Debounced `touch`: update `last_viewed_at`, renew `expires_at`, bump usage counters.

Also: CSRF protection on auth endpoints; OIDC `state` + PKCE; magic links single-use, 10-minute TTL, rate limited per email and IP; default `Content-Security-Policy: frame-ancestors 'self'` unless manifest relaxes it; request size, timeout, and per-app rate limits.

## 10. Identity header contract (what apps receive)

```
X-SCAD-User-Email:  verified email
X-SCAD-User-Id:     stable user uuid
X-SCAD-User-Name:   display name (may be empty)
X-SCAD-Identity:    JWT (EdDSA), 60 s lifetime
```

JWT claims: `iss` (auth host), `aud` (app id), `sub` (user id), `email`, `name`, `iat`, `exp`. Public keys at `https://auth.{BASE_DOMAIN}/.well-known/jwks.json`. Apps may trust the plain headers (network guarantees only the gateway can reach them) or verify the JWT.

## 11. Manifest (`scad.json`, all fields optional)

```json
{
  "name": "sprint-tracker",
  "port": 3000,
  "start": "node server.js",
  "env": { "NODE_ENV": "production" },
  "egress": ["api.github.com"],
  "resources": { "memory_mb": 512, "disk_gb": 1 },
  "frame_ancestors": "self"
}
```

Defaults and caps: port 8080; memory 512 MB (cap 1024); disk 1 GB (cap 5); 1 CPU share; 128 pids. Slugs: `[a-z0-9-]{3,40}`.

## 12. Security invariants (each MUST have an automated test)

1. An app container can never reach another app, the control plane, the gateway's admin ports, the Docker socket, the host, or any cloud metadata address (169.254.169.254 and equivalents).
2. App containers have **no default route to the internet**. Only the egress proxy provides outbound access, and only to approved domains. The proxy resolves DNS itself and blocks private, loopback, link-local, and metadata ranges **after resolution** (defeats DNS rebinding).
3. The gateway strips client-supplied `X-SCAD-*` headers before injecting its own.
4. Session cookies are host-only. A cookie for app A is never valid for app B.
5. Login codes and magic links are single-use, short-lived, hashed at rest, and bound to their audience.
6. Containers run as non-root, read-only root filesystem (writable `/tmp` as tmpfs and `/data` volume), all capabilities dropped, `no-new-privileges`, memory/CPU/pids limits enforced. Use the `runsc` (gVisor) runtime when available.
7. Secrets are envelope-encrypted, write-only through the API, never logged, injected only at container start.
8. The builder has no access to platform secrets, the Docker socket is never mounted into app containers, and builds cannot reach the control plane.
9. Operator suspend takes effect at the gateway within 5 seconds.
10. A user can only see, change, or delete their own apps (and apps shared to them for viewing only).
11. Hostnames are derived from validated slugs and handles; no user input is ever interpolated into shell commands, file paths, or DNS names unvalidated.
12. Logs never contain tokens, cookies, secrets, or full identity JWTs.

## 13. Conventions

- Small, reviewable PRs, one task ID per PR. Commit format: `T1.2: add share/unshare endpoints`.
- Write the **failing security/acceptance test first** for any invariant in section 12.
- Validate every external input with zod. Never trust the manifest, tarball contents, hostnames, or headers.
- No provider-specific imports outside `packages/runtime-*`.
- No new dependencies without a one-line justification in the PR description. Pin versions.
- Return structured errors per section 8; never leak stack traces.
- Keep functions small, name things after the domain model, avoid cleverness.
- Update `docs/` and `.env.example` when behavior or config changes.

## 14. Defaults you may change only with human approval

App limits: 10 live apps per builder, 100 MB upload, 10-minute build timeout, 10-minute idle stop, 15-second wake budget, 7-day log retention, 1 GB volume. Operator allowlist of who may sign in at all (`OPERATOR_EMAILS` plus an invited-emails table).

## 15. Decisions reserved for the human (ask, do not guess)

Instance domain and public hosting method; open-source license; whether friends may publish or only the founder; production provider choice and spending cap; auto-detect build tool (Railpack vs Nixpacks vs Buildpacks); data retention policy; anything that widens what a published app may access.

## 16. Definition of done for v1

All M0 to M2 tasks complete with acceptance passing in CI; `tests/adversarial` green for every invariant in section 12; a second person has published and shared an app without help; the operator can suspend any app or user and see usage; README lets a new developer run everything locally in under 15 minutes.
