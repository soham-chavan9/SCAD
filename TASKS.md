# SCAD: Build Plan (agent-executable)

Prerequisite: read `AGENTS.md` completely. It defines decisions, contracts, and security invariants referenced here as **D#**, **§#**, and **INV#** (section 12 items).

## How to work

1. Do tasks **in order**, one at a time. Respect `Depends`.
2. For each task: read it, write the failing test(s) from **Acceptance**, implement, make them pass, run `pnpm lint && pnpm typecheck && pnpm test`.
3. Do not start the next task until the current one's acceptance passes. If blocked or if a decision is reserved for the human (AGENTS §15), **stop and ask**.
4. One task = one branch/PR, commit prefix is the task ID. Tick the checkbox in this file in the same PR.
5. Do not add features outside the task. Out-of-scope ideas go in `docs/ideas.md`.

Legend: **Files** = where work happens. **Done when** = the acceptance checks, all required.

---

## M0: Spike. A toy app is live behind GitHub login (target 1 to 2 weeks)

- [x] **T0.1 Monorepo, tooling, CI**
  - Files: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, eslint/prettier/vitest config, `.github/workflows/ci.yml`, `.env.example`, `README.md`, `docker-compose.yml` (Postgres, Mailpit).
  - Steps: create the layout from AGENTS §5 with empty packages that each export a placeholder and one passing test; strict TS; CI runs lint, typecheck, test.
  - Done when: `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass locally and in CI; `docker compose up -d` brings up Postgres and Mailpit.

- [x] **T0.2 Shared package**
  - Depends: T0.1. Files: `packages/shared`.
  - Steps: zod schemas for manifest (§11), error envelope and codes (§8), slug/handle validators, JWT sign/verify helpers (EdDSA, `jose`), id helpers.
  - Done when: unit tests cover valid/invalid manifests (bad slug, memory over cap, bad port), error envelope shape, JWT round-trip, wrong-audience and expired rejection.

- [x] **T0.3 Control plane skeleton and database**
  - Depends: T0.2. Files: `apps/control-plane`, Drizzle schema and migrations for `users, apps, releases, machines, pats, audit_events` (full model in §7 can land later).
  - Steps: Fastify app, `/healthz`, PAT auth plugin (hashed tokens), `POST /v1/apps` internal create used by tests, structured error handler returning §8 envelope.
  - Done when: `pnpm db:migrate` works on a fresh DB; request without token returns `401 UNAUTHENTICATED` envelope; valid PAT creates an app row; integration test uses a real Postgres.

- [x] **T0.4 RuntimeProvider interface and Docker driver (basic)**
  - Depends: T0.2. Files: `packages/runtime-docker`, `packages/runtime-conformance`.
  - Steps: implement the §4 interface with `dockerode`: per-app internal Docker network (`internal: true`), named volume mounted at `/data`, container with hardened settings from INV6 (non-root enforced via image USER check, read-only rootfs, cap-drop ALL, no-new-privileges, limits). Return `Reachable` via the container's IP on the app network. Gateway container attachment comes in T0.7.
  - Done when: conformance suite passes (deploy, start, stop, status, logs, remove with and without volume, idempotent `ensureApp`); a deployed sample container is not reachable from another app's network.

- [x] **T0.5 CLI login and publish (Dockerfile apps)**
  - Depends: T0.3, T0.4. Files: `packages/cli`, `packages/api-client`, `apps/builder`, control-plane publish route, `examples/hello-node`.
  - Steps: device-code login storing a PAT in `~/.config/scad/config.json` (mode 600); `scad publish [dir]` tars respecting `.gitignore` and `.scadignore`, rejects over 100 MB; control plane stores tarball, creates release, builder runs `docker build`, smoke-checks that the declared port answers HTTP within 30 s, then calls `RuntimeProvider.deploy`; failed release leaves the previous release serving; response and logs stream back the URL.
  - Done when: `scad publish examples/hello-node` prints a URL and the container is running; breaking the Dockerfile returns `BUILD_FAILED` with `hint` and `details.log_tail`; an app not listening on its port returns `PORT_NOT_LISTENING`.

- [x] **T0.6 Gateway v0: routing and GitHub sign-in**
  - Depends: T0.3. Files: `apps/gateway`, auth host routes, `users`/`sessions`/`login_codes` migrations.
  - Steps: implement §9 steps 1 to 5 with GitHub OAuth (`openid-client`, `state`), host-only cookies, one-time code exchange, ACL = owner only for now. User handle derived from GitHub login, validated and unique.
  - Done when: unauthenticated request redirects to auth host then back and shows the app; a different GitHub user gets 403; cookie from app A is rejected on app B (INV4); login code reuse and expiry fail (INV5).

- [x] **T0.7 Gateway to app proxy and identity headers**
  - Depends: T0.4, T0.6. Files: `apps/gateway`, `examples/echo-identity`, `docker-compose.yml`.
  - Steps: run gateway as a container; when an app is deployed the driver connects the gateway container to that app's network; proxy HTTP and WebSocket; strip then inject `X-SCAD-*` headers (§10); JWKS endpoint.
  - Done when: echo app shows verified email; request with forged `X-SCAD-User-Email` is overridden (INV3); JWT verifies against JWKS and fails with wrong audience; apps remain unreachable from the host and from each other.

- [x] **T0.8 Hardening (smoke safety, fake-auth gate, safe tar, INV tests)**
  - Depends: T0.7. Files: `scripts/m0-smoke.sh`, `apps/gateway`, `apps/builder`, `apps/control-plane`, `packages/runtime-docker`, `packages/shared`, `docs/t0.8-docker-build-exposure.md`.
  - Steps:
    - Audit PR #10 changes outside the smoke script; document file + why.
    - Smoke: no sudo/sysctl/iptables on the default path; `--vm-only` may apply Linux bridge-nf / DOCKER-USER tweaks and **refuses on macOS**. Document why VM needed `bridge-nf-call-iptables=0` + DOCKER-USER ACCEPT, which checks FAIL without them, and isolation meaning. Smoke must run on macOS Docker Desktop without sudo.
    - `GATEWAY_FAKE_AUTH`: gateway **refuses to start** if on and `BASE_DOMAIN` is not localhost-based; off in `.env.example`; unit test.
    - Safe tarball extract to a fresh temp dir only; reject absolute/`..`/device/FIFO/hardlink/symlink-outside-root; limits on total size, file count, per-file size; skip `node_modules` and `.git`; one malicious-tar test per case with structured errors.
    - Docker build exposure: **report only** (network mode, user, build-args, mounts, daemon; probe reachability from a `RUN` step). Do not change build network without asking.
    - Real (not mocked) INV1 / INV2 / INV6 / INV11 tests; `manifest.start` passed as argv array (never host-shell interpolated).
    - `/internal/resolve` returns manifest port (not hardcoded 8080).
  - Done in T2.6: GitHub sign-in is gated by the invite allowlist; `OPERATOR_EMAILS` are the operators.
  - Done when:
    - [x] PR #10 audit listed in PR body / internal note
    - [x] Smoke default path has no sudo; `--vm-only` refuses on macOS
    - [x] `GATEWAY_FAKE_AUTH` localhost guard + test; off in `.env.example`
    - [x] Safe extract + malicious tar tests
    - [x] Docker build exposure report published (no network change)
    - [x] INV1 / INV2 / INV6 / INV11 tests green
    - [x] `manifest.start` as argv (file+line: `packages/runtime-docker/src/docker-provider.ts:72`)
    - [x] `/internal/resolve` uses manifest port + test
    - [x] `pnpm lint && pnpm typecheck && pnpm test` green
    - [x] Full `m0-smoke.sh` on macOS Docker Desktop (sudo-free, no `--vm-only`; checks 1–7 passed on this Mac)
    - [ ] Human GitHub second-account 403 browser check

- [x] **T0.9 Build isolation (INV8)**
  - Depends: T0.5. Do not start M1, and do not let a friend publish, until this is closed.
  - Decision (human): `docker build --network=none`; Dockerfiles must not fetch dependencies during `RUN`. See `docs/build-isolation.md`.
  - Done when:
    - [x] Builder runs `docker build --network=none`, no build args/secrets/ssh (`apps/builder/src/docker-build.ts`)
    - [x] docker CLI env limited to `PATH`/`HOME`/`TMPDIR`/`DOCKER_*`; builder drops platform secrets from its env at startup; smoke starts builder under `env -i`
    - [x] INV8 real-Docker test: `RUN` cannot reach control plane, Postgres, Mailpit, host, metadata, internet, DNS (`tests/adversarial/src/inv8-build-isolation.test.ts`)
    - [x] `examples/*` build with `--network=none` (echo-identity no longer runs `npm install`)
    - [x] README + docs updated

**Resolved in T2.6:** sign-up is invite-only. Only `OPERATOR_EMAILS`, emails an app was shared to, and the operator's invite list (`scad admin invite add|rm|ls`) may create an account by GitHub or magic link; anyone else gets a "not invited" page and no account row. `OPERATOR_EMAILS` are also the operators (device-code approval and `/v1/admin`).

**M0 exit:** publish a toy app, open it in the browser behind GitHub login, with a second GitHub account denied.

---

## M1: Alpha. Friends can use an app you published (weeks 3 to 4)

- [x] **T1.1 Magic-link sign-in**
  - Depends: T0.6. Files: gateway/auth host, `magic_links` migration, SMTP mailer (Mailpit locally).
  - Done when: link arrives in Mailpit, works once, expires after 10 minutes, rate limits per email and IP; an unknown email still gets the same response (no account enumeration).
  - Tests: `apps/gateway/src/magic-link.integration.test.ts`. Docs: `docs/sign-in.md`. `/login` is now a chooser page; GitHub starts at `/login/github`.

- [x] **T1.2 Allowlists and sharing**
  - Depends: T0.7. Files: control plane share routes, CLI `share`/`unshare`/`ls`, gateway ACL, `app_access` migration.
  - Steps: share by email (user may not exist yet); first sign-in with that email links the account; `visibility=instance` option.
  - Done when: allowlisted friend gets in, others get 403; unshare takes effect within 5 seconds; owners cannot manage others' apps (INV10).
  - Tests: `apps/gateway/src/sharing.integration.test.ts`, `packages/cli/src/share.test.ts`. Docs: `docs/sharing.md`. Adds `GET /v1/apps/:id/share` and `PATCH /v1/apps/:id {visibility}` to the §8 routes.

- [x] **T1.3 Persistent `/data` volume**
  - Depends: T0.4. Files: runtime-docker, control plane.
  - Done when: a counter app's data survives stop/start and redeploy; `remove` with `deleteVolume: false` keeps data; volume size limit enforced.
  - Tests: `packages/runtime-docker/src/volume.test.ts`. Docs: `docs/data-volume.md`. Size limit is **measured** (refuse start/deploy when over; `enforceVolumeQuota` stops a running app) because Docker local volumes have no hard quota. A periodic caller lands with the scheduler (T1.4/T2.5).

- [x] **T1.4 Idle stop and wake on request**
  - Depends: T0.7. Files: control plane scheduler (`last_request_at`), `/internal/wake`, gateway wake page.
  - Steps: stop after 10 minutes without traffic unless pinned; single-flight wake so 50 concurrent requests cause one start.
  - Done when: stopped app serves the first request within 10 s; wake storm test shows exactly one `start` call; HTML navigations see the self-retrying page.
  - Tests: `apps/control-plane/src/idle-wake.integration.test.ts`, `apps/gateway/src/wake.integration.test.ts`, `packages/runtime-docker/src/wake-latency.test.ts` (real Docker, ~2.7 s). Docs: `docs/idle-wake.md`. Adds `/internal/touch` (already in §8) and the control plane now holds a `RuntimeProvider`.

- [x] **T1.5 Manifest handling**
  - Depends: T0.5. Done when: `scad.json` fields drive port, start command, env, resources; invalid manifests return `MANIFEST_INVALID` with a field-level hint; defaults from §11 apply when absent.
  - Tests: `apps/control-plane/src/manifest-publish.integration.test.ts`, `packages/shared/src/manifest.test.ts`, and the real-Docker case in `publish.integration.test.ts`. Docs: `docs/manifest.md`. The control plane reads root `scad.json` from the tarball; the smoke check now runs the manifest `start`/`env`. `egress` and `frame_ancestors` are stored only (T2.1 and later).

- [x] **T1.6 Env vars and encrypted secrets**
  - Depends: T0.3. Files: `env_vars` migration, crypto helper using `MASTER_KEY` (AES-256-GCM, per-record nonce), CLI `env set`.
  - Done when: secrets are write-only (never returned by GET, never in logs, never in audit metadata); injected at start; rotating `MASTER_KEY` procedure documented (INV7, INV12).
  - Tests: `apps/control-plane/src/secrets/crypto.test.ts`, `apps/control-plane/src/env.integration.test.ts`, `packages/cli/src/env.test.ts`, real-Docker case in `publish.integration.test.ts`. Docs: `docs/secrets.md`. Envelope encryption (per-record data key wrapped by `MASTER_KEY`); `scad env set|unset|ls`; env changes redeploy the app. Adds `GET /v1/apps/:id/env` to the §8 routes.

- [x] **T1.7 Runtime logs**
  - Depends: T0.4. Done when: `scad logs <app> -f` streams live stdout/stderr; non-owners cannot read logs; 7-day retention job.
  - Tests: `packages/runtime-docker/src/logs-stream.test.ts` (real Docker follow), `apps/control-plane/src/logs.integration.test.ts` (SSE, INV10, disconnect, retention job), `packages/cli/src/logs.test.ts`. Docs: `docs/logs.md`. Runtime logs (T1.7b): collected into the control plane's `runtime_logs` table, which `scad logs` reads; a daily job deletes rows older than 7 days (`apps/control-plane/src/runtime-log-store.integration.test.ts`). Docker json-file is a 2x1 MB rotating buffer only. Build logs: daily 7-day prune.

- [x] **T1.8 MCP server**
  - Depends: T0.5, T1.2, T1.6, T1.7. Files: `packages/mcp-server`.
  - Steps: tools `publish`, `list_apps`, `get_app`, `share`, `unshare`, `set_env`, `get_logs`, `delete_app`. Descriptions must state purpose, inputs, and error meanings. Errors pass through the §8 envelope including `hint`.
  - Done when: a scripted agent session publishes `examples/hello-node` and shares it using only MCP tools; a forced build error gives the agent enough in `hint` + `log_tail` to fix and retry successfully.
  - Tests: `tests/e2e/src/mcp-agent.test.ts` (real Docker), `packages/mcp-server/src/server.test.ts`, `apps/builder/src/build-hint.test.ts`, `apps/control-plane/src/delete-app.integration.test.ts`. Docs: `docs/mcp.md`. Also lands §8 `DELETE /v1/apps/:id` (needed by `delete_app`) and a network-aware `BUILD_FAILED` hint.

- [x] **T1.9 Identity token hardening**
  - Depends: T0.7. Done when: JWT rotation via `kid` supported; key rotation test passes; sample verifying snippet in `docs/identity.md`.
  - Tests: `apps/gateway/src/identity/rotation.test.ts`. Docs: `docs/identity.md`. `kid` is the key's RFC 7638 thumbprint; `JWT_PREVIOUS_PUBLIC_KEY` keeps retired keys in the JWKS during a rotation; JWKS is served with `Cache-Control: public, max-age=300`; `examples/echo-identity` refetches the JWKS once on an unknown kid.

**M1 exit:** one friend, on their own machine's browser, signs in with magic link or GitHub and uses an app you published.

---

## M2: Beta. A friend publishes unaided, and the platform is safe to trust (weeks 5 to 6)

- [x] **T2.1 Egress proxy and network policy**
  - Depends: T0.4. Files: `apps/egress-proxy`, runtime-docker network wiring.
  - Steps: app networks stay `internal: true`; the egress proxy container is attached to each app network and to an external network; apps get `HTTP_PROXY`/`HTTPS_PROXY` env; proxy identifies the app by source IP, applies that app's allowlist (manifest `egress` filtered by operator policy), resolves DNS itself, blocks private/loopback/link-local/metadata ranges after resolution.
  - Done when (INV1, INV2): adversarial app cannot reach undeclared hosts, `169.254.169.254`, the host gateway IP, other apps, or the Docker socket; allowed domain works; DNS rebinding test fails to reach private IPs.
  - Tests: `tests/adversarial/src/inv2-egress-proxy.test.ts` (real Docker), `apps/egress-proxy/src/proxy.test.ts`, manifest egress validation in `packages/shared/src/manifest.test.ts`. Docs: `docs/egress.md`. Operator policy is `EGRESS_ALLOWED_DOMAINS` on the proxy: default `*` allows any declared public domain (T2.1b, human decision Nov 9), a comma list narrows it, `none` denies all. The builder's smoke check still runs off the app network (see build-schedule); that moves to T2.2.

- [x] **T2.2 Hardened container profile and optional gVisor**
  - Depends: T0.4. Done when: runtime test inspects container config for non-root, read-only rootfs, caps dropped, limits set (INV6); `runsc` used automatically when installed and documented when not; fork bomb and memory hog sample apps are contained.
  - Tests: `packages/runtime-docker/src/hardening.test.ts`, the INV6 case in `invariants.test.ts`, `packages/runtime-docker/src/smoke.test.ts`, `tests/adversarial/src/inv6-resource-limits.test.ts` (`examples/adversarial/fork-bomb`, `memory-hog`). Docs: `docs/hardening.md`. The builder's smoke check now runs on the app's internal network with the deploy's profile (closes the Day 2 finding). gVisor is not available on Docker Desktop for Mac, so the `runsc` path is unit-tested only.

- [x] **T2.3 Limits and quotas**
  - Depends: T1.5. Done when: 11th live app, 101 MB upload, over-cap memory request, and build timeout each return the right code (`LIMIT_EXCEEDED`, `UPLOAD_TOO_LARGE`, `BUILD_FAILED`) with a useful `hint`.
  - Tests: `apps/control-plane/src/limits.integration.test.ts`, `apps/builder/src/build-timeout.test.ts`. Docs: `docs/limits.md`. The live-app cap counts the whole instance (§14 "per builder"); over-cap `resources` are now `LIMIT_EXCEEDED` instead of `MANIFEST_INVALID`. Fixed: a 101 MB upload returned `500 INTERNAL`.

- [x] **T2.4 Auto-detect builds**
  - Depends: T0.5. Reserved decision: tool choice (AGENTS §15). **Ask the human before choosing.** Human chose built-in templates (Nov 8).
  - Done when: a directory with only `package.json` and a Python app with `requirements.txt` and a static site folder each publish without a Dockerfile.
  - Tests: `apps/builder/src/autodetect.test.ts`, `apps/builder/src/autodetect.docker.test.ts`, T2.4 cases in `apps/control-plane/src/publish.integration.test.ts`. Docs: `docs/autodetect.md`. Examples: `hello-python`, `hello-static`. Builds stay `--network=none`: npm dependencies must be bundled, Python packages vendored as `wheels/`; installing from registries needs a human decision (see build-schedule "Blocked").

- [x] **T2.5 Lifecycle jobs**
  - Depends: T1.4. Files: scheduler.
  - Steps: idle stopper (1 min), expiry notifier (daily, email 7 days before), expirer (stop at `expires_at`, delete 14 days later), orphan reaper (reconcile driver state vs DB), usage roll-up (hourly). Viewing renews expiry; `pinned` apps exempt.
  - Done when: fake-clock tests walk an app through warn, stop, grace, delete; viewing resets expiry; reaper flags a container with no DB row.
  - Tests: `apps/control-plane/src/lifecycle.integration.test.ts`, `packages/runtime-docker/src/inventory.test.ts`. Docs: `docs/lifecycle.md`. Publishing now sets `expires_at` (it was never set before). The reaper flags orphans and marks missing machines; it does not delete Docker resources on its own. Requests are counted per debounced gateway touch.

- [x] **T2.6 Operator controls and audit**
  - Depends: T1.2. Files: admin routes, CLI `scad admin ...`, audit writer.
  - Done when: suspending an app or user blocks the gateway within 5 seconds (INV9); every publish, share, unshare, suspend, delete writes an `audit_events` row; non-operators get 403.
  - Tests: `apps/control-plane/src/admin.integration.test.ts`, `apps/gateway/src/operator-controls.integration.test.ts` (INV9 with a cached resolver, open WebSocket closed, invite allowlist), `packages/cli/src/admin.test.ts`. Docs: `docs/operator.md`, `docs/sign-in.md`. The gateway ACL now reads app and owner status fresh per request (the 30 s resolve cache no longer delays a suspend); open WebSockets re-check every 2 s. Includes the invite allowlist (human decision, Nov 8): `invites` table (migration 0007), `scad admin invite add|rm|ls`. Adds `/v1/admin` users, unsuspend, invites, and audit routes to §8.

- [x] **T2.7 Usage and cost visibility**
  - Depends: T2.5. Done when: `scad admin usage` and a minimal operator page show per-app requests, unique viewers, last viewed, running hours, volume size.
  - Tests: `apps/control-plane/src/usage.integration.test.ts` (fake clock: touches, window, running hours across stop/wake, volume from the quota sweep, page CSP), `packages/cli/src/admin.test.ts`. Docs: `docs/usage.md`. `GET /v1/admin/usage` and the static operator page `GET /admin` on the control plane (token pasted into the page, kept in `sessionStorage`). Migration 0008 adds `machines.running_seconds`, `volume_bytes`, `volume_measured_at`; drivers may offer the optional `volumeUsage` capability. Page checked by hand in a browser with seeded data.

- [x] **T2.8 Adversarial test suite**
  - Depends: T2.1, T2.2. Files: `tests/adversarial` with hostile sample apps.
  - Scenarios (all must be blocked, all run in CI): read another app's volume or env; reach control plane, metadata IP, host, Docker socket; exfiltrate to undeclared host; spoof identity headers; forge or replay cookies and login codes; exhaust CPU, memory, pids, disk; escape sandbox via privileged syscalls.
  - Done when: every scenario has a named test mapped to its INV number and the suite is green in CI.
  - Tests: `tests/adversarial/src/hostile-apps.test.ts` (real Docker: `examples/adversarial/snoop`, `escape`, `cpu-hog`, `disk-filler`), `tests/adversarial/src/identity-and-sessions.test.ts` (INV3/4/5/10 against the real gateway and control plane), plus the existing INV2/INV6/INV8 files. Scenario to test to INV matrix: `tests/adversarial/README.md`. Fixed: a malformed session cookie returned `500` from the gateway (now treated as no session).

- [x] **T2.9 Runbook and README**
  - Depends: all above. Done when: `docs/runbook.md` covers restore, key rotation, suspend/delete user data, disaster reset; a fresh clone runs end-to-end locally in under 15 minutes following README.
  - Docs: `docs/runbook.md` (state inventory, backup, restore, rotation table, suspend and delete user data, disaster reset, health checks; the backup and restore commands were run against a scratch database and volume). README now starts with an end-to-end path; new `scripts/setup-env.sh` and `scripts/with-env.sh`. Adds operator `DELETE /v1/admin/apps/:id` (`scad admin delete-app`). A fresh clone followed the README to a signed-in app in a real browser in 89 s (warm Docker and pnpm caches). That run found and fixed three bugs: a relative `SCAD_DATA_DIR` split uploads between the control plane and builder; the gateway refused to start without GitHub OAuth (email sign-in now works alone); and a recreated gateway or egress proxy dropped off every app network until a redeploy (now re-attached on wake and by the 5-minute sweep). Tests: `apps/control-plane/src/storage.test.ts`, `apps/gateway/src/github-optional.test.ts`, `packages/runtime-docker/src/reconnect.test.ts`, delete case in `admin.integration.test.ts`.

**M2 exit:** a friend publishes an app on their own, shares it, and the adversarial suite is green.

---

## M3: Share a website with a link (human approved Nov 11)

SCAD's M3 promise: **a non-technical founder builds a website with an AI agent on their laptop and sends friends an https link to a hosted copy, with no hosting setup.** Flow: vibe code, ask the agent to publish the local folder through SCAD's MCP tools, get a link. GitHub features are M4. Scope is **every kind of website**: plain pages, static builds from any common framework or generator, and server-rendered JS sites (Next.js, Nuxt, SvelteKit, Remix, Astro SSR). Apps with a backend (APIs, databases, Python/PHP servers) move to M4. Code for all stages is built overnight Nov 11 as one PR per task; deploy and founder checks follow in the morning. Founder plan, CTO decisions, and risks: `docs/m3-plan.md`.

Decisions (Nov 11): a hosted copy, not a live tunnel; every kind of website in M3, backend apps in M4; $0 hosting on an Oracle Cloud Always Free VM (this Mac as fallback); a DuckDNS subdomain; Gmail SMTP for magic links; MCP-first; only the founder publishes; links are private by default, and the agent asks whether a site should be public instead (T3.5; AGENTS §3 and §7 updated); a trusted fetch step for build dependencies (Blocked option c); publishing from a GitHub repo URL moved to M4 (T4.7). Each stage ends with a check the founder runs. Old M3 IDs: T3.1 kept; Fly → M4 T4.6; OIDC → M4 T4.4; rollback → T3.6; snapshots → M4 T4.3; image scanning → M4 T4.5.

### Stage 1: a link that works for anyone

- [ ] **T3.1 Public hosting at $0**
  - Files: `deploy/` (production Compose, Caddy config), gateway/control-plane config, `docs/deploy.md`.
  - Steps: a TLS front (Caddy) with on-demand certificates that asks the control plane whether a hostname is the auth host, the API host, or a live app before issuing; `BASE_DOMAIN` and every public URL come from env (the Compose file hardcodes `localhost:8080` today); an `api.{BASE_DOMAIN}` host so the CLI and MCP reach the control plane remotely; production config: fake auth refused, Gmail SMTP (app password supplied by the founder) for magic links, only 80/443 open, Postgres/builder/control-plane internals not exposed; backups of `MASTER_KEY`, JWT keys, and Postgres (runbook); arm64 images; gVisor run for real on the Linux host (closes Blocked #6). Verify first that DuckDNS resolves two-level names (`{slug}.{owner}.{name}.duckdns.org`).
  - Founder step (they enter all cards and passwords): Oracle account and VM, DuckDNS name, Gmail app password.
  - Done when: a phone on mobile data opens `https://{slug}.{owner}.{BASE_DOMAIN}`, gets a magic link by real email, and sees `hello-static`; an unknown hostname gets no certificate; the adversarial suite passes on the host; `docs/deploy.md` takes a fresh VM to a live link.

### Stage 2: every static website builds

- [x] **T3.2 Static site builds with a trusted dependency fetch**
  - Depends: T2.4. Steps: a trusted fetch container with registry-only egress (npm, and RubyGems for Jekyll) runs before the `--network=none` build: `npm ci --ignore-scripts` from the lockfile (npm, pnpm, yarn, bun lockfiles; `--package-lock-only --ignore-scripts` first when there is none) and `bundle cache` for Jekyll; pinned Hugo binary from a checksum-verified release; size and time caps; the fetch never sees platform secrets. The build runs the `build` script offline, then the image keeps only the output folder behind the existing static server, with single-page-app fallback to `index.html`. Detect: Vite (React, Vue, Svelte, Solid, Preact), Create React App, Angular, Astro (static), Gatsby, Docusaurus, VitePress, Eleventy, Next.js `output: "export"`, Nuxt `generate`, SvelteKit `adapter-static`, Hugo, Jekyll; unknown frameworks fall back to `npm run build` plus the first of `dist/`, `build/`, `out/`, `public/`, `_site/`. Packages that need install scripts or native builds fail with a hint naming the package.
  - Done when: one example per framework family publishes with no Dockerfile and no `scad.json` (`hello-vite`, `hello-vue`, `hello-svelte`, `hello-angular`, `hello-astro`, `hello-docusaurus`, `hello-next-export`, `hello-hugo`, `hello-jekyll`); client-side routes reload without 404; the build step still has no network (INV8 test unchanged and green); a `postinstall` script does not run; a fetch to a non-registry host is refused.

### Stage 3: server-rendered websites

- [ ] **T3.3 Server-rendered JS sites**
  - Depends: T3.2. Steps: Next.js (standalone output), Nuxt (Nitro node server), SvelteKit (`adapter-node`), Remix/React Router, Astro (node adapter) run on the Node template with production `node_modules` from the fetch step, listening on `PORT`, under the same hardened profile and egress rules. Where a project is missing the node adapter or standalone setting, the build adds it without editing the founder's files, or the hint says what to change. Projects that are backend apps (an Express/Fastify/Flask `start` with no site framework) get a hint that backend apps come in M4.
  - Done when: `hello-next`, `hello-nuxt`, `hello-sveltekit`, `hello-remix`, `hello-astro-ssr` publish with no Dockerfile, render server-side pages, and wake from idle within the 15 s budget. Founder check: a Next.js site freshly generated by Claude Code publishes unchanged.

### Stage 4: publish by asking

- [ ] **T3.4 Founder onboarding (MCP-first)**
  - Depends: T3.1. Steps: one pasted command installs the CLI and registers the SCAD MCP server with Claude Code (and Cursor) pointed at the public instance; `scad login` device approval works from a remote machine; every error `hint` is plain English and tells the agent the next action; MCP `publish` returns the link and `share` emails the friend; `docs/getting-started.md` assumes no terminal knowledge beyond pasting one command.
  - Done when: on a second laptop, a person who has never seen SCAD goes from nothing to a shared https link by telling their agent "publish this and share it with <email>", following only the guide. Closes the M2 exit check.

### Stage 5: private or public link

- [x] **T3.5 Public links (opt-in, private stays the default)**
  - Depends: T1.2, T3.4. Human decision Nov 11: the founder chooses per site; the protected link is the default.
  - Steps: `visibility` gains `public` (migration with down; default stays `allowlist`). `scad publish --public`, `scad visibility <app> public|private`, and a `visibility` field on the MCP `publish` tool whose description tells the agent to ask "private (only people you share with) or public (anyone with the link)?" and to use private when there is no clear answer. The gateway serves public sites without sign-in; identity headers and the JWT are injected only when the viewer has a session, and spoofed `X-SCAD-*` headers are always stripped (INV3). Public sites send `X-Robots-Tag: noindex` (anyone with the link, not search engines) and get a per-IP rate limit for anonymous requests. Visibility changes write an audit row; operator suspend still blocks within 5 s (INV9). The publish result says plainly which kind of link it is.
  - Done when: a signed-out browser sees a public site and gets the sign-in page for a private one; switching public to private blocks a signed-out viewer within 5 s; spoofed identity headers never reach a public app; the MCP tool asks and defaults to private; adversarial suite green.

### Stage 6: undo

- [ ] **T3.6 Rollback.** `scad rollback` and an MCP `rollback` tool return to the previous release in one step ("that update broke it, go back"). Done when the founder publishes a broken change and undoes it.

**M3 exit:** a non-technical person vibe codes a website of any kind on their own laptop, publishes the folder by asking their agent, and a friend on another network opens the https link and sees it (after signing in for a private link, directly for a public one).

---

## M4: Apps with a backend, and GitHub (after M3; ask the human before starting)

- [ ] **T4.1 Backend dependencies.** Extend the T3.2 fetch step to backend apps: Node API servers, Python `pip download --only-binary=:all:` for a plain `requirements.txt`.
- [ ] **T4.2 Backend framework auto-detect.** Express/Fastify, Flask/FastAPI/Django, PHP; examples `hello-express`, `hello-flask`, `hello-php`.
- [ ] **T4.3 Volume snapshots** (nightly, 7-day retention, on the host's disk; one-command restore; note provider costs).
- [ ] **T4.4 Generic OIDC providers** (Google first, then Workspace, Entra, Okta) as configuration.
- [ ] **T4.5 Image scanning** as a publish-time warning; ownership transfer.
- [ ] **T4.6 Fly driver.** Only when the free host is outgrown. `packages/runtime-fly` passes the same conformance suite; must verify four things first and report results: egress control, per-app private networking, volume semantics, scale-to-zero latency. Include a hard **spending cap and per-app budget alert** before first real deploy.
- [ ] **T4.7 Publish from a GitHub repo URL**
  - Depends: T0.5, T1.8. Steps: `scad publish https://github.com/{owner}/{repo}[/tree/{ref}]` and an optional `repo` field on the MCP `publish` tool. The CLI/MCP on the founder's machine downloads the repo archive with the founder's own git or `gh` credentials and uploads it through the normal publish path, so the control plane gains no GitHub access and private repos need no server secrets. Same 100 MB cap and manifest rules.
  - Done when: a public repo and a private repo (with `gh` signed in) each publish to a link; a bad URL, a missing ref, and no access each return a clear `hint`.

## Appendix A: sample apps required in `examples/`

- `hello-node`: minimal HTTP server on port 8080 with a Dockerfile.
- `echo-identity`: prints verified `X-SCAD-*` headers and verifies the JWT.
- `counter-sqlite`: writes a counter to `/data/app.db`, used for persistence tests.
- `hello-python`, `hello-static`: used for auto-detect in T2.4.
- `adversarial/*`: one hostile app per scenario in T2.8.

## Appendix B: per-task review checklist

Before marking any task done: acceptance tests pass; security invariants touched have named tests; no secrets or tokens in logs; every new endpoint validates input with zod and enforces ownership; errors carry `hint`; docs and `.env.example` updated; no provider-specific code outside `packages/runtime-*`.
