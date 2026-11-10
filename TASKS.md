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
  - TODO (before gateway is reachable outside localhost): gate GitHub sign-in with an invite allowlist, and fix `OPERATOR_EMAILS` scope (who may sign in vs who is operator).
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

**Warning:** GitHub sign-in creates an account for anyone with a GitHub account. `OPERATOR_EMAILS` gates only device-code approval (`POST /v1/auth/device/approve`), not GitHub sign-in. Fix that before the gateway is reachable outside localhost.

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

- [ ] **T1.8 MCP server**
  - Depends: T0.5, T1.2, T1.6, T1.7. Files: `packages/mcp-server`.
  - Steps: tools `publish`, `list_apps`, `get_app`, `share`, `unshare`, `set_env`, `get_logs`, `delete_app`. Descriptions must state purpose, inputs, and error meanings. Errors pass through the §8 envelope including `hint`.
  - Done when: a scripted agent session publishes `examples/hello-node` and shares it using only MCP tools; a forced build error gives the agent enough in `hint` + `log_tail` to fix and retry successfully.

- [ ] **T1.9 Identity token hardening**
  - Depends: T0.7. Done when: JWT rotation via `kid` supported; key rotation test passes; sample verifying snippet in `docs/identity.md`.

**M1 exit:** one friend, on their own machine's browser, signs in with magic link or GitHub and uses an app you published.

---

## M2: Beta. A friend publishes unaided, and the platform is safe to trust (weeks 5 to 6)

- [ ] **T2.1 Egress proxy and network policy**
  - Depends: T0.4. Files: `apps/egress-proxy`, runtime-docker network wiring.
  - Steps: app networks stay `internal: true`; the egress proxy container is attached to each app network and to an external network; apps get `HTTP_PROXY`/`HTTPS_PROXY` env; proxy identifies the app by source IP, applies that app's allowlist (manifest `egress` filtered by operator policy), resolves DNS itself, blocks private/loopback/link-local/metadata ranges after resolution.
  - Done when (INV1, INV2): adversarial app cannot reach undeclared hosts, `169.254.169.254`, the host gateway IP, other apps, or the Docker socket; allowed domain works; DNS rebinding test fails to reach private IPs.

- [ ] **T2.2 Hardened container profile and optional gVisor**
  - Depends: T0.4. Done when: runtime test inspects container config for non-root, read-only rootfs, caps dropped, limits set (INV6); `runsc` used automatically when installed and documented when not; fork bomb and memory hog sample apps are contained.

- [ ] **T2.3 Limits and quotas**
  - Depends: T1.5. Done when: 11th live app, 101 MB upload, over-cap memory request, and build timeout each return the right code (`LIMIT_EXCEEDED`, `UPLOAD_TOO_LARGE`, `BUILD_FAILED`) with a useful `hint`.

- [ ] **T2.4 Auto-detect builds**
  - Depends: T0.5. Reserved decision: tool choice (AGENTS §15). **Ask the human before choosing.**
  - Done when: a directory with only `package.json` and a Python app with `requirements.txt` and a static site folder each publish without a Dockerfile.

- [ ] **T2.5 Lifecycle jobs**
  - Depends: T1.4. Files: scheduler.
  - Steps: idle stopper (1 min), expiry notifier (daily, email 7 days before), expirer (stop at `expires_at`, delete 14 days later), orphan reaper (reconcile driver state vs DB), usage roll-up (hourly). Viewing renews expiry; `pinned` apps exempt.
  - Done when: fake-clock tests walk an app through warn, stop, grace, delete; viewing resets expiry; reaper flags a container with no DB row.

- [ ] **T2.6 Operator controls and audit**
  - Depends: T1.2. Files: admin routes, CLI `scad admin ...`, audit writer.
  - Done when: suspending an app or user blocks the gateway within 5 seconds (INV9); every publish, share, unshare, suspend, delete writes an `audit_events` row; non-operators get 403.

- [ ] **T2.7 Usage and cost visibility**
  - Depends: T2.5. Done when: `scad admin usage` and a minimal operator page show per-app requests, unique viewers, last viewed, running hours, volume size.

- [ ] **T2.8 Adversarial test suite**
  - Depends: T2.1, T2.2. Files: `tests/adversarial` with hostile sample apps.
  - Scenarios (all must be blocked, all run in CI): read another app's volume or env; reach control plane, metadata IP, host, Docker socket; exfiltrate to undeclared host; spoof identity headers; forge or replay cookies and login codes; exhaust CPU, memory, pids, disk; escape sandbox via privileged syscalls.
  - Done when: every scenario has a named test mapped to its INV number and the suite is green in CI.

- [ ] **T2.9 Runbook and README**
  - Depends: all above. Done when: `docs/runbook.md` covers restore, key rotation, suspend/delete user data, disaster reset; a fresh clone runs end-to-end locally in under 15 minutes following README.

**M2 exit:** a friend publishes an app on their own, shares it, and the adversarial suite is green.

---

## M3: Beyond local (only after M2; ask the human before starting)

- [ ] **T3.1 Public hosting plan.** Human decides domain and method (home machine with a tunnel, VPS, or cloud). Deliver: deployment guide, TLS for the wildcard domain, hardened gateway and control plane config. No code that hardcodes a host.
- [ ] **T3.2 Fly driver.** `packages/runtime-fly` passes the same conformance suite; must verify four things first and report results: egress control, per-app private networking, volume semantics, scale-to-zero latency. Include a hard **spending cap and per-app budget alert** before first real deploy.
- [ ] **T3.3 Generic OIDC providers** (Google Workspace, Entra, Okta) as configuration.
- [ ] **T3.4 Rollback and ownership transfer.**
- [ ] **T3.5 Volume snapshots** (nightly, 7-day retention; note provider snapshot costs).
- [ ] **T3.6 Image scanning** as a publish-time warning.

## Appendix A: sample apps required in `examples/`

- `hello-node`: minimal HTTP server on port 8080 with a Dockerfile.
- `echo-identity`: prints verified `X-SCAD-*` headers and verifies the JWT.
- `counter-sqlite`: writes a counter to `/data/app.db`, used for persistence tests.
- `hello-python`, `hello-static`: used for auto-detect in T2.4.
- `adversarial/*`: one hostile app per scenario in T2.8.

## Appendix B: per-task review checklist

Before marking any task done: acceptance tests pass; security invariants touched have named tests; no secrets or tokens in logs; every new endpoint validates input with zod and enforces ownership; errors carry `hint`; docs and `.env.example` updated; no provider-specific code outside `packages/runtime-*`.
