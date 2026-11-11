# SCAD 5-day build schedule (daily run notes)

Plan: Day 1 (Nov 6) T0.9, T1.1, T1.2, T1.3 · Day 2 T1.4–T1.7 · Day 3 T1.7b, T1.8, T1.9, T2.1 ·
Day 4 T2.2–T2.5 · Day 5 T2.6–T2.9. Never start M3.

## Day 1 — 2026-11-06

`gh` is **not authenticated** on this Mac (`gh auth status`: not logged in), so
nothing was pushed and no PRs exist. All branches are local and **stacked**,
each on the previous one (none of the parents are merged):

```
origin/dev
 └─ task/t0-9-build-isolation
     └─ task/t1-1-magic-link
         └─ task/t1-2-sharing
             └─ task/t1-3-data-volume
```

To publish them: `gh auth login`, then push each branch and open PRs in this
order, each based on its parent (T0.9 → `dev`, T1.1 → `task/t0-9-build-isolation`,
and so on). Or merge them into `dev` in order.

| Task | Status | Branch | PR | Not verified / notes |
|---|---|---|---|---|
| T0.9 Build isolation (INV8) | done | `task/t0-9-build-isolation` | none (gh not authed) | — |
| T1.1 Magic-link sign-in | done | `task/t1-1-magic-link` | none | Manual browser check of the email flow through the Compose gateway not done (covered by inject tests + real Mailpit delivery test). |
| T1.2 Allowlists and sharing | done | `task/t1-2-sharing` | none | "Friend on their own machine's browser" is the M1 exit, still a human check. |
| T1.3 Persistent `/data` | done | `task/t1-3-data-volume` | none | Size limit is measured, not hard (see Blocked). |

### What changed

- **T0.9**: `docker build --network=none --progress=plain`, no build args; the
  docker CLI gets only `PATH`/`HOME`/`TMPDIR`/`DOCKER_*`; the builder deletes
  platform secrets from its env at startup; smoke starts the builder under
  `env -i`. `examples/echo-identity` verifies JWTs with `node:crypto` instead
  of `npm install jose`. INV8 real-Docker test with a positive control. Also
  fixed `pnpm test:adversarial` / `pnpm test:e2e`, which found no tests before.
- **T1.1**: `/login` is now a chooser page (GitHub moved to `/login/github`);
  `POST /login/email` with double-submit CSRF; `magic_links` table (hashed,
  single-use, 10 min, bound to app host); GET on the link shows a Continue
  button and only the POST consumes it; 5/15 min per email and 20/15 min per
  IP; identical response for unknown emails. New dependency:
  `nodemailer@10.2.1` (SMTP client for magic-link mail; ships its own types).
  `zod@4.6.7` added to the gateway (already pinned in the workspace). CI gets
  a Mailpit service; Compose gateway gets `SMTP_URL=smtp://mailpit:1025`.
- **T1.2**: `app_access` table; `POST/GET/DELETE /v1/apps/:id/share`,
  `PATCH /v1/apps/:id {visibility}` (the GET and PATCH are additions to the
  AGENTS §8 list); audit rows; gateway ACL (HTTP + WebSocket) reads the
  allowlist and visibility fresh per request; magic links go to shared emails
  and create the account on first use; CLI `scad share|unshare|ls`.
- **T1.3**: `examples/counter-sqlite` (built-in `node:sqlite`); deploy makes
  `/data` writable for the image's non-root user via a trusted helper; measured
  quota (`VolumeQuotaExceededError` → `LIMIT_EXCEEDED`), `volumeUsage`,
  `enforceVolumeQuota`.

### Tests

- `pnpm lint` and `pnpm typecheck` green on `task/t1-3-data-volume`.
- Targeted suites green: builder, gateway (incl. magic-link, sharing), control
  plane routes/db, CLI, api-client, INV8 adversarial, runtime-docker volume
  tests, publish integration (hello-node, broken Dockerfile, not-listening).
- **Pre-existing flake on this Mac**: Docker-backed tests in
  `invariants.test.ts`, `conformance.test.ts`, and `publish.integration.test.ts`
  sometimes hang 15+ minutes on a Docker API call (a different test each run;
  on `dev` before any change the baseline had 3 such timeouts, and a re-run had
  2 different ones while the earlier failures passed). Looks like Docker
  Desktop stalls, not a code regression, but worth a look.

### Full run

A full `pnpm test` was not re-run at the end of Day 1: with the Docker stalls
it takes over an hour. Instead, on `task/t1-3-data-volume`:

- All Docker-backed files together (`runtime-docker/*`, `publish.integration`,
  `tests/adversarial`): 22 passed, 3 timed out (conformance "remove without
  deleteVolume", volume "counter survives", INV8 control build), each stalled
  ~15 min on a Docker call.
- Re-run one file at a time: INV8 2/2 passed, volume 3/3 passed (16 s);
  conformance stalled again in one re-run. These match the stalls already
  seen on `dev` before any Day 1 change.
- Cleanup hooks time out during the stalls, so `scad-run-*` test containers
  from `scad-test/*` images pile up. Remove them before the next run:
  `docker ps -a --format '{{.ID}} {{.Image}}' | awk '$2 ~ /^scad-test\//{print $1}' | xargs docker rm -f`.
- Next step: find the stalling Docker call (likely container stop/wait on
  Docker Desktop 29.9) before Day 2 adds more Docker tests.

## Day 2 — 2026-11-07

`gh` is still **not authenticated**, so again nothing was pushed and no PRs
exist. Docker Desktop was **paused** at the start of the run (`docker info`:
"manually paused"); the daily run ran `docker desktop restart` to resume it. The
Day 1 Docker stalls may have been this pause, so the full run below rechecks.

Today's branches continue the local stack:

```
task/t1-3-data-volume
 └─ task/t1-4-idle-wake
     └─ task/t1-5-manifest
         └─ task/t1-6-env-secrets
             └─ task/t1-7-runtime-logs
```

| Task | Status | Branch | PR | Not verified / notes |
|---|---|---|---|---|
| T1.4 Idle stop and wake | done | `task/t1-4-idle-wake` | none (gh not authed) | Wait page not clicked through in a real browser; covered by inject tests. |
| T1.5 Manifest handling | done | `task/t1-5-manifest` | none | `egress` and `frame_ancestors` are stored only (T2.1 / later). |
| T1.6 Env vars and secrets | done | `task/t1-6-env-secrets` | none | Rotation procedure tested in code, not run against a live instance. |
| T1.7 Runtime logs | done | `task/t1-7-runtime-logs` | none | Runtime log lines older than 7 days are hidden, not erased (see Blocked). |

### What changed

- **T1.4**: `MachineController` in the control plane (it now holds a
  `RuntimeProvider`; `server.ts` is the only place that picks Docker).
  Single-flight `POST /internal/wake`, `POST /internal/touch`, and a 1-minute
  idle sweep that stops unpinned apps idle for 10 minutes. The gateway's
  `WakeCoordinator` does single-flight wakes, waits for the app's port,
  holds non-HTML requests up to 15 s (then `503` + `Retry-After`), shows HTML
  navigations a self-reloading "Starting…" page after 3 s, wakes on proxy
  connect failure (stale resolve cache), holds WebSocket upgrades, and sends a
  debounced touch (30 s). Real Docker: stopped app answers in ~2.7 s.
- **T1.5**: The control plane reads root `scad.json` from the tarball (an
  explicit `manifest` form field wins). `MANIFEST_INVALID` hints name the field
  (`describeManifestIssues`), env keys are validated, scad.json is capped at 64
  KB. Fixed: the smoke check ignored `start`/`env`, so a manifest `start` that
  changed the port failed smoke. `deploySpecFromManifest` and `startToArgv` moved
  to `@scad/shared`. Dependency: `tar@7.5.22` added to the control plane (already
  pinned in the builder) to read `scad.json` from the upload without writing to
  disk.
- **T1.6**: `env_vars` table (migration 0004 + down). Envelope encryption:
  per-record AES-256-GCM data key, wrapped by `MASTER_KEY`, AAD bound to
  app + key, key fingerprint for rotation. `PUT`/`GET /v1/apps/:id/env`
  (secrets never returned), audit rows with key names only, env changes redeploy
  the current release, the builder fetches decrypted env just in time via
  `POST /internal/builds/:id/runtime-env` (only while building, never into
  `docker build`). `MASTER_KEY_PREVIOUS` + `rotate-master-key` script.
  `scad env set|unset|ls`. Dev dependencies: `dockerode@5.0.1` and
  `@types/dockerode@4.0.2` in the control plane (tests inspect containers; same
  pins as runtime-docker).
- **T1.7**: Incremental Docker log demuxer (the old code buffered the whole
  follow stream, so `-f` could never stream). Containers get json-file
  `max-size=10m,max-file=3`; the driver serves only the last 7 days.
  `GET /v1/apps/:id/logs` SSE (owner only, heartbeat, stops on disconnect).
  `scad logs <app> [-f] [-n N]`. Daily build-log prune (7 days).

### Tests

Full gate on `task/t1-7-runtime-logs` (which has all of Day 1 and Day 2), with Docker
Desktop running:

- `pnpm lint && pnpm typecheck && pnpm test`: **58 files, 223 tests passed in
  140 s**, including every Docker-backed suite (conformance, invariants,
  volume, INV8, publish integration, wake latency, live logs).
- `pnpm test:adversarial`: 2 files / 3 tests passed. `pnpm test:e2e`: 1 passed.
- **No Docker stalls this time.** Day 1's 15-minute hangs were most likely
  Docker Desktop being paused; the whole suite now takes about 2.5 minutes.

### Finding for Day 3 (T2.1/T2.2)

The builder's smoke check (`apps/builder/src/smoke.ts`) runs the untrusted image
on Docker's default bridge with a published port, not on the app's internal
network, and without the INV6 hardening (non-root check, read-only rootfs, cap
drop, limits). During those ≤30 s the app has outbound internet and can reach
the host, and since T1.6 it also has the app's env. This predates Day 2. Fix it
in T2.1/T2.2: run smoke on an internal network with the deploy's hardening, and
probe from a helper container on that network.

## Day 3 — 2026-11-08

`gh` is now authenticated (account `soham-chavan9`). At the start of the run the
eight Day 1–2 branches were pushed (attribution check clean) and their stacked
PRs opened. Docker Desktop was running (not paused).

```
origin/dev
 └─ task/t0-9-build-isolation      #19 → dev
     └─ task/t1-1-magic-link        #20
         └─ task/t1-2-sharing       #26
             └─ task/t1-3-data-volume  #21
                 └─ task/t1-4-idle-wake   #22
                     └─ task/t1-5-manifest   #23
                         └─ task/t1-6-env-secrets   #24
                             └─ task/t1-7-runtime-logs   #25
                                 └─ task/t1-7b-log-deletion   #27
                                     └─ task/t1-8-mcp-server   #28
                                         └─ task/t1-9-identity-rotation   #29
                                             └─ task/t2-1-egress-proxy   #30
```

Each PR targets its parent branch. Merge in order from #19; after each merge,
retarget the next PR to `dev` (GitHub does this automatically when the base
branch is deleted on merge).

| Task | Status | Branch | PR | Not verified / notes |
|---|---|---|---|---|
| T0.9 Build isolation | done (Day 1) | `task/t0-9-build-isolation` | [#19](https://github.com/soham-chavan9/small-cloud/pull/19) | — |
| T1.1 Magic link | done (Day 1) | `task/t1-1-magic-link` | [#20](https://github.com/soham-chavan9/small-cloud/pull/20) | Manual browser click-through |
| T1.2 Sharing | done (Day 1) | `task/t1-2-sharing` | [#26](https://github.com/soham-chavan9/small-cloud/pull/26) | Friend's own browser (M1 exit) |
| T1.3 `/data` | done (Day 1) | `task/t1-3-data-volume` | [#21](https://github.com/soham-chavan9/small-cloud/pull/21) | Limit is measured (accepted) |
| T1.4 Idle/wake | done (Day 2) | `task/t1-4-idle-wake` | [#22](https://github.com/soham-chavan9/small-cloud/pull/22) | Wait page not clicked in a browser |
| T1.5 Manifest | done (Day 2) | `task/t1-5-manifest` | [#23](https://github.com/soham-chavan9/small-cloud/pull/23) | — |
| T1.6 Env/secrets | done (Day 2) | `task/t1-6-env-secrets` | [#24](https://github.com/soham-chavan9/small-cloud/pull/24) | Rotation not run on a live instance |
| T1.7 Runtime logs | done (Day 2) | `task/t1-7-runtime-logs` | [#25](https://github.com/soham-chavan9/small-cloud/pull/25) | Retention made real in T1.7b |
| T1.7b Log deletion + §8 routes | done | `task/t1-7b-log-deletion` | [#27](https://github.com/soham-chavan9/small-cloud/pull/27) | Lines written while the control plane is down are not collected |
| T1.8 MCP server | done | `task/t1-8-mcp-server` | [#28](https://github.com/soham-chavan9/small-cloud/pull/28) | Not tried from a real MCP client app (stdio bin untested by hand) |
| T1.9 Identity token hardening | done | `task/t1-9-identity-rotation` | [#29](https://github.com/soham-chavan9/small-cloud/pull/29) | Rotation not run against the Compose gateway by hand |
| T2.1 Egress proxy | done | `task/t2-1-egress-proxy` | [#30](https://github.com/soham-chavan9/small-cloud/pull/30) | Smoke check still runs off the app network (moved to T2.2) |

### What changed

- **T1.7b** (human decision: real deletion). New `runtime_logs` table
  (migration 0005). A `RuntimeLogCollector` in the control plane follows each
  running app and copies its lines into the table. It attaches on wake and
  redeploy, plus a 5 s sweep for builder deploys and restarts. New containers
  are read from their start; known ones resume without duplicates.
  - Secret env values are redacted before insert.
  - Flood cap: 2,000 lines per app per 250 ms, with a "dropped" marker line.
  - `scad logs` and the SSE route read only from the table; `-f` checks it
    every 300 ms.
  - The daily job **deletes** rows older than 7 days. The test counts rows
    directly in SQL.
  - Docker json-file shrank to 2 x 1 MB.
  - AGENTS.md §8 now lists the approved routes (`GET/PATCH` share and
    visibility, `GET env`, internal `runtime-env`). `docs/data-volume.md`
    records the measured-limit decision.
- **T1.8**: `@scad/mcp-server` (`scad-mcp` stdio) with `publish`, `list_apps`,
  `get_app`, `share`, `unshare`, `set_env`, `get_logs`, `delete_app`.
  - Errors are the §8 envelope; `delete_app` needs `confirm: true`.
  - Added §8 `DELETE /v1/apps/:id` (owner-only; removes container and
    volume; clears shares, env, logs; audited).
  - `BUILD_FAILED` hints now recognise download failures under
    `--network=none` and say to vendor dependencies. The e2e test drives a
    scripted agent through fail → fix → succeed.
  - Dependency: `@modelcontextprotocol/sdk@1.32.2`.
- **T1.9**: `kid` is now the RFC 7638 thumbprint.
  - `JWT_PREVIOUS_PUBLIC_KEY` keeps retired keys in the JWKS during a
    rotation.
  - JWKS is served with `Cache-Control: public, max-age=300`.
  - `@scad/shared` `verifyIdentityJwtWithJwks` selects keys by kid.
  - `examples/echo-identity` refetches the JWKS once on an unknown kid.
  - `docs/identity.md` has the snippet and runbook.
- **T2.1**: `apps/egress-proxy` (Node built-ins only, runs via type
  stripping; image builds offline).
  - The driver attaches `scad-egress` to every app network, sets
    `HTTP(S)_PROXY` (apps can't override it), and writes
    `{appId, subnet, allow}` policy files to `~/.scad/egress-policy`, which
    the proxy mounts read-only.
  - The proxy identifies apps by source subnet. It requires manifest `egress`
    ∩ operator `EGRESS_ALLOWED_DOMAINS` (empty = deny all), resolves DNS
    itself, and refuses any private, loopback, link-local, metadata, or
    reserved address.
  - Manifest `egress` entries are now validated as public hostnames.
  - New Compose service `egress-proxy`.

### Tests

Full gate on `task/t2-1-egress-proxy` (top of the stack; includes every Day 1–3 change):

- `pnpm lint && pnpm typecheck`: green.
- `pnpm test`: **66 files, 316 tests passed**, including every Docker-backed
  suite, the new real-Docker egress suite, and the MCP e2e.
- `pnpm test:adversarial`: 3 files / 15 tests passed. `pnpm test:e2e`: 2 files
  / 3 tests passed. Both first failed because two new tests used paths relative
  to the working directory (these scripts run from `tests/*`); fixed on the
  T2.1 branch. The T1.8 PR alone still has that bug in
  `tests/e2e/src/mcp-agent.test.ts` under `pnpm test:e2e` (root `pnpm test`
  is fine); the fix lands with T2.1.
- On the T1.8 branch, two runtime-docker tests first failed on leaked
  networks (see below); they re-ran green after cleanup.
- Today's egress run had internet access, so the "allowed domain works" and
  DNS-rebinding cases ran (not skipped).

### Finding: leaked Docker networks

When Docker-backed tests stall or crash, their per-app `scad-net-*` networks
are left behind. Once there are about 24, Docker refuses to create more ("all
predefined address pools have been fully subnetted") and runtime-docker tests
fail. That happened today on the T1.8 run. The daily run removed the 20 empty
networks that belonged to no app in the dev database; re-runs were green. To
clean up by hand:

```bash
docker network ls --format '{{.Name}}' | grep '^scad-net-' | xargs -n1 docker network rm 2>/dev/null
```

(Removing a network that still has a container fails harmlessly.) T2.5's
orphan reaper should also reap networks.

## Day 4 — 2026-11-09

Docker Desktop was **not running** at the start of the run (`docker info`: no
socket); the daily run ran `docker desktop start` and it came up in under a
minute. `gh` is authenticated. None of the Day 1–3 PRs (#19–#30) are merged
yet, so today's branches continue the stack:

```
task/t2-1-egress-proxy   #30
 └─ task/t2-2-hardened-profile   #31
     └─ task/t2-3-limits   #32
         └─ task/t2-4-autodetect   #33
             └─ task/t2-5-lifecycle   #34
```

| Task | Status | Branch | PR | Not verified / notes |
|---|---|---|---|---|
| T2.2 Hardened profile + gVisor | done | `task/t2-2-hardened-profile` | [#31](https://github.com/soham-chavan9/small-cloud/pull/31) | Real `runsc` not run: Docker Desktop for Mac has no gVisor (unit-tested only) |
| T2.3 Limits and quotas | done | `task/t2-3-limits` | [#32](https://github.com/soham-chavan9/small-cloud/pull/32) | Live-app cap is instance-wide (see below) |
| T2.4 Auto-detect builds | done | `task/t2-4-autodetect` | [#33](https://github.com/soham-chavan9/small-cloud/pull/33) | Installing from npm/PyPI is blocked (see Blocked) |
| T2.5 Lifecycle jobs | done | `task/t2-5-lifecycle` | [#34](https://github.com/soham-chavan9/small-cloud/pull/34) | Expiry email not checked in Mailpit (fake mailer in tests) |

### What changed

- **T2.2**: one hardened profile (`hardenedHostConfig`) for deploy and smoke.
  Adds no swap (`MemorySwap = Memory`) and `nodev` on `/tmp`.
  - gVisor: `SCAD_OCI_RUNTIME=auto|runsc|runc`, default `auto` (uses `runsc`
    when Docker lists it). The builder logs the choice at startup.
  - **The smoke check now runs on the app's internal network** with the
    deploy's profile, no egress proxy, and a throwaway tmpfs `/data`, probed
    by a busybox helper. This closes the Day 2 finding. A positive-control
    test shows the same probe app does leak on the default bridge.
  - Root images get `BUILD_FAILED` with a USER hint, not
    `PORT_NOT_LISTENING`.
  - Hostile samples `examples/adversarial/fork-bomb` and `memory-hog` are
    contained: pids stay at or under the limit, the hog is OOM-killed, and
    the neighbour keeps serving. Docs: `docs/hardening.md`.
- **T2.3**: the 11th live app gets `403 LIMIT_EXCEEDED` (advisory-locked
  count; republish is never blocked). A 101 MB upload gets
  `413 UPLOAD_TOO_LARGE`; **it used to be `500 INTERNAL`**. Over-cap
  `memory_mb`/`disk_gb` gets `LIMIT_EXCEEDED`. Builds are killed after 10
  minutes and return `BUILD_FAILED` (`timed_out`); BuildKit really cancels
  the `RUN` step. Docs: `docs/limits.md`.
- **T2.4**: built-in templates when there is no Dockerfile: `package.json` →
  `node:22-alpine`, `requirements.txt` → `python:3.12-alpine` (vendored
  `wheels/` install offline, tested for real), `index.html` → busybox
  `httpd`. All run non-root and set `PORT`. New examples `hello-python` and
  `hello-static`. MCP and CLI descriptions updated. Docs: `docs/autodetect.md`.
- **T2.5**: publishing sets `expires_at` (it was never set before); views
  renew it.
  - Jobs: expiry notifier (daily email), expirer (10 min), 14-day grace
    deleter, orphan reaper (hourly; flags, never auto-removes), usage roll-up
    (hourly). Pinned apps are exempt.
  - Migration 0006 adds `expiry_warned_at`, `usage_viewers`, `usage_daily`.
  - Dependency: `nodemailer@10.2.1` in the control plane (same pin as the
    gateway). Docs: `docs/lifecycle.md`.

### Tests

Full gate on `task/t2-5-lifecycle` (top of the stack; includes everything):

- `pnpm lint && pnpm typecheck`: green.
- `pnpm test`: **75 files, 367 tests passed** (every Docker-backed suite
  included).
- `pnpm test:adversarial`: 4 files / 17 tests passed (new: INV6 resource
  limits). `pnpm test:e2e`: 2 files / 3 tests passed.
- Each branch passed the full gate when it was committed: T2.2 69/332,
  T2.3 71/342, T2.4 73/359.

### Choices to review

- **Live-app cap scope (T2.3).** AGENTS §14 says "10 live apps per builder".
  With one builder this is implemented as 10 for the whole instance, not 10
  per owner. If you meant per owner, it is a one-line change in
  `apps/control-plane/src/routes/publish.ts`.
- **Orphan reaper only flags.** The local Docker daemon is shared with test
  runs, so auto-removing would also delete test resources. It writes
  `runtime.orphan` audit rows and a log line; removal stays manual
  (`docs/lifecycle.md`).

## Day 5 — 2026-11-10

Run early, at 06:30 instead of 09:00, at the human's request. The scheduled
task was disabled on purpose, so this run was started by hand. Docker Desktop
was running and `gh` was authenticated. `dev` already had all of T0.9–T2.5
(PR #35 landed the stack).

| Task | Status | Branch | PR | Not verified / notes |
|---|---|---|---|---|
| T2.1b Egress default | done, merged | `task/t2-1b-egress-default` | [#36](https://github.com/soham-chavan9/small-cloud/pull/36) → `dev` | — |
| T2.6 Operator controls + invite allowlist | done, merged | `task/t2-6-operator-controls` | [#37](https://github.com/soham-chavan9/small-cloud/pull/37) → `dev` | "Not invited" page not clicked in a browser (covered by inject tests) |
| T2.7 Usage and cost visibility | done | `task/t2-7-usage` | [#38](https://github.com/soham-chavan9/small-cloud/pull/38) merged into `task/t2-6-operator-controls`, **not `dev`**; [#39](https://github.com/soham-chavan9/small-cloud/pull/39) → `dev` lands it | Running hours before migration 0008 were never recorded |
| T2.8 Adversarial suite | done | `task/t2-8-adversarial` | [#40](https://github.com/soham-chavan9/small-cloud/pull/40) → `dev` | — |
| T2.9 Runbook and README | done | `task/t2-9-runbook` | [#41](https://github.com/soham-chavan9/small-cloud/pull/41) → `dev` | Fresh-clone timing used warm Docker/pnpm caches |

**PR bases.** This repo doesn't delete branches on merge, so GitHub never
retargets a stacked PR. #38 had base `task/t2-6-operator-controls` and merged
into that branch 25 s after #37 merged, so T2.7 never reached `dev`. #39
(`task/t2-7-usage` → `dev`) lands it. Every other Day 5 PR targets `dev`
directly. **Merge in order: #39, #40, then #41.** Each later branch contains
the earlier ones, so until its parent merges a PR also shows the parent's
commits. No open PR has a base other than `dev`.

### What changed

- **T2.1b** (human decision, Nov 9): `EGRESS_ALLOWED_DOMAINS` unset, empty,
  or `*` lets apps reach any public domain they declare. A comma list narrows
  that; `none` refuses all egress. Undeclared domains and private or reserved
  addresses stay refused (INV2). The proxy logs the active policy at startup.
- **T2.6**:
  - `/v1/admin` routes, for operators only (`OPERATOR_EMAILS`):
    - users list;
    - suspend and unsuspend users and apps;
    - invite add, rm, ls;
    - audit feed.
  - Every change is audited.
  - **INV9:** the gateway ACL used to read app and owner status from its 30 s
    resolve cache. It now reads them fresh on every request, and open
    WebSockets re-check access every 2 s.
  - A dropped WebSocket used to leave the connection to the app open. That
    is fixed.
  - Suspended apps stay down. The owner can't republish one, an env change
    doesn't restart it, and a build that finishes later doesn't start it.
  - **Invite allowlist** (human decision, Nov 8):
    - Only `OPERATOR_EMAILS`, shared-to emails, and invited emails can
      create an account.
    - Everyone else gets a "not invited" page and no account row.
    - Existing accounts keep access.
    - The magic-link request page stays the same for everyone.
  - Migration 0007 (`invites`). CLI: `scad admin ...`.
- **T2.7**:
  - `GET /v1/admin/usage` and `scad admin usage` show per app:
    - requests and unique viewers, from the raw counters, so they are
      current;
    - last viewed;
    - all-time running hours;
    - last measured `/data` size.
  - Static operator page at the control plane's `/admin`. The operator pastes
    a PAT, which stays in that tab only. Strict CSP. Checked in a browser.
  - Migration 0008 (`machines.running_seconds`, `volume_bytes`,
    `volume_measured_at`). New optional driver capability: `volumeUsage`.
- **T2.8**:
  - Hostile apps `snoop`, `escape`, `cpu-hog`, and `disk-filler`, plus
    attacker tests for INV3/4/5/10 against the real gateway and control
    plane.
  - Every T2.8 scenario has a test named by its INV.
  - Matrix: `tests/adversarial/README.md`.
  - Found and fixed: a malformed session cookie made the gateway answer 500.
- **T2.9**:
  - `docs/runbook.md` covers:
    - backup and restore, with the commands run against a scratch DB and
      volume;
    - key and secret rotation;
    - suspending and deleting a user's data, via the new
      `scad admin delete-app`;
    - disaster reset;
    - health checks.
  - The README starts with one end-to-end path; new `scripts/setup-env.sh`
    and `scripts/with-env.sh`.
  - The fresh-clone run found and fixed three bugs:
    - a relative `SCAD_DATA_DIR` split uploads between the control plane and
      the builder, so the first publish failed;
    - the gateway refused to start without a GitHub OAuth app (email sign-in
      now works on its own);
    - a recreated gateway or egress proxy dropped off every app network
      until a redeploy (now re-attached on wake and by the 5-minute sweep).

### Tests

- Each task passed the full gate before its PR. Numbers:
  - T2.1b: 77 files, 394 tests.
  - T2.6: 80 files, 426 tests.
  - T2.8: 83 files, 479 tests; adversarial 6 files, 63 tests.
  - e2e: 3/3 every time.
- T2.7's first local gate had one real failure that I misread as T2.8 noise:
  `migrate.down.test.ts` required `DROP TABLE` in every down script, and 0008
  only drops columns. CI on #39 caught it. The fix (accept column-only down
  scripts) was pushed to #39 and cherry-picked onto T2.8. CI now passes on
  #39 and #40, including the new Docker adversarial suite on Linux.
- T2.9 (top of the stack, everything): 86 files, 490 tests; adversarial 63; e2e 3.
- **Fresh clone, README only** (second run, final code): clone → install →
  `setup-env` → `compose up` → migrate → start both services → login →
  publish → sign in by emailed link in a browser → app loads: **89 s**. Docker
  images and the pnpm store were cached; a first-ever install also downloads
  those. To run it, the existing Compose stack was taken down (containers
  only; its Postgres volume was kept) and brought back up afterwards.

### Choices to review

- **CPU is weighted, not capped.** `cpuShares` keeps a hog from starving a
  neighbour (tested), but an app alone on an idle host can use every core. A
  hard cap (`NanoCpus`) would change a default.
- **Extra admin routes** beyond the §8 list: unsuspend, `GET /admin/users`,
  invites, `GET /admin/audit`, and `DELETE /admin/apps/:id`. All are in AGENTS
  §8.
- **Unsuspending an app** sets it to `stopped`; the next view wakes it.
- Still open from Day 4: the live-app cap counts the whole instance, not each
  owner.

## M2 exit status

M2 exit: *a friend publishes an app on their own, shares it, and the
adversarial suite is green.*

- [x] All M2 tasks (T2.1–T2.9) are done with acceptance passing. T2.7–T2.9 are
  in PRs #39, #40, and #41, waiting to merge.
- [x] Adversarial suite green: locally, and in CI on #40.
- [x] The operator can suspend any app or user and see usage (v1 definition of
  done).
- [x] README runs end to end from a fresh clone (89 s with warm caches).
- [ ] **A friend publishes and shares an app on their own.** Needs a second
  person. It also needs public hosting (M3, human decision) unless they use
  this machine.
- [ ] The T0.8 GitHub second-account 403 check in a browser (human).

M2 is code-complete; the exit needs the human checks above. M3 has not been
started.

## Resolved by human (Nov 8)

1. **gh auth / PRs.** `gh` is authenticated; all branches are pushed and the
   stacked PRs #19–#29 are open.
2. **`/data` size limit (T1.3).** The measured limit is accepted for local and
   M2: "measured, not hard; revisit with the M3 provider". Documented in
   `docs/data-volume.md`; no code change.
3. **Runtime log retention (T1.7).** Real deletion required. Done in T1.7b
   (`runtime_logs` table plus a daily delete job), PR #27.
4. **API routes.** `GET /v1/apps/:id/share`, `PATCH /v1/apps/:id {visibility}`,
   `GET /v1/apps/:id/env`, and internal `POST /internal/builds/:id/runtime-env`
   are approved and added to AGENTS.md §8 (in PR #27).
5. **Sign-up / `visibility=instance`.** An invite allowlist will be built in
   T2.6 (Day 5): `OPERATOR_EMAILS`, shared emails, and an operator-managed
   invite list.

## Resolved by human (Nov 9)

1. **Egress default (T2.1).** Apps may reach any public domain they declare in
   `scad.json` `egress` without a separate approval. Done in T2.1b: the default
   `EGRESS_ALLOWED_DOMAINS` is `*` (unset or empty means the same), a comma
   list narrows it, and `none` refuses all egress. Undeclared domains and
   private/reserved addresses stay refused (INV2). See `docs/egress.md`.
2. **Merges.** Done on Nov 10: PR #35 landed the stack, so `dev` has all of T0.9–T2.5.

## Resolved by human (Nov 11)

1. **M3 scope.** SCAD shares a **hosted copy** of a website by link (not a
   live tunnel). M3 covers every kind of website: plain pages, static builds from
   any common framework or generator, and server-rendered JS sites (Next.js,
   Nuxt, SvelteKit, Remix, Astro SSR). Backend apps move to M4. Code for all
   M3 tasks is built overnight Nov 11; deploy and founder checks follow. Plan: `docs/m3-plan.md`; tasks:
   TASKS.md M3 and M4.
2. **Hosting (AGENTS §15).** $0 for the prototype: Oracle Cloud Always Free
   VM, this Mac as fallback; DuckDNS subdomain first; Gmail SMTP for magic
   links. The founder does the sign-ups and enters all credentials.
3. **Dependency installs (Blocked #3).** Option (c), a trusted fetch step
   with the build kept offline: build dependencies in T3.2, runtime
   dependencies for server-rendered sites in T3.3, backend apps in M4 (T4.1).
4. **GitHub.** All GitHub features move to M4. Publish from a repo URL,
   downloaded on the founder's machine (T4.7); no auto-redeploy on push.
5. **Who publishes.** Only the founder in M3; friends view and still sign in.
   Public links: the agent asks the founder per site; a protected
   (allowlist) link is the default, public (anyone with the link, no
   sign-in) is opt-in (T3.5). AGENTS §3 and §7 updated.
6. **Merges.** #39, #40, and #41 are merged into `dev`.

## M3 track A (Nov 11, overnight)

| Task | Status | Branch | PR | Notes |
|---|---|---|---|---|
| T3.1 Public hosting at $0 | code done, live checks need founder | `task/t3-1-hosting` | see PR list | Checkbox left unticked: the live acceptance needs the founder's accounts |
| T3.6 Rollback | code done, founder check pending | `task/t3-6-rollback` | see PR list | Automated equivalent of the founder check passes on real Docker |
| T3.5 Public links | done | `task/t3-5-public-links` | see PR list | Private stays the default; adversarial suite has a public-links file |
| T3.4 Founder onboarding | code done, second-laptop check needs founder | `task/t3-4-onboarding` | see PR list | Fresh-laptop install simulated end to end in `tests/e2e/src/install.test.ts` |

**T3.1 notes.** Built host-agnostic and proved locally:

- Caddy on-demand TLS (`deploy/Caddyfile`) asks the control plane
  (`GET /internal/tls-ask?domain=`) before every certificate. Allowed: `auth.`,
  `api.`, and hosts of apps that exist (any status but deleted, so a suspended
  site shows its page instead of a certificate error). Tests:
  `apps/control-plane/src/tls-ask.integration.test.ts`.
- `scripts/tls-smoke.sh` ran the real Caddyfile (Caddy 2.10.2, internal CA in
  place of Let's Encrypt) against the real ask endpoint: live app, `api.`,
  `auth.` got certificates; unknown app and foreign hosts got none; `/internal/*`
  is 404 through `api.`. 6/6 passed on this Mac.
- `deploy/compose.yml`: only Caddy publishes 80/443; Postgres on
  `127.0.0.1` only; gateway unpublished; `NODE_ENV=production` and
  `GATEWAY_FAKE_AUTH="0"` hard-coded; everything from `BASE_DOMAIN`.
  Control plane and builder run on the host under systemd (they drive the
  Docker socket, as in dev). Policy test: `apps/gateway/src/deploy-config.policy.test.ts`.
- `api.{BASE_DOMAIN}`: the control plane's public URL defaults to
  `https://api.{BASE_DOMAIN}` on a real domain (`PUBLIC_BASE_URL` still wins).
- Gateway: refuses fake auth when `NODE_ENV=production`; trusts
  `X-Forwarded-For` only from Caddy's pinned IP (`GATEWAY_TRUST_PROXY`), so
  per-IP sign-in limits are per viewer, not one bucket for everyone behind
  Caddy. Fastify's hop-count form did not pick the right address in tests,
  so only IP/CIDR lists are accepted.
- Device approval (`auth-device.ts`): already ignored forwarded headers for the
  IP; now also refuses any request that carries a forwarding header, so a
  proxy on the same host can never make a remote caller look like loopback.
  Remote `scad login` approval through the browser is T3.4.
- `deploy/firewall.sh`: 80/443 in; port 4000 only from the platform network;
  app containers reach no host service. `deploy/backup.sh`: Postgres, `.env`
  (MASTER_KEY, JWT keys), app volumes, `SCAD_DATA_DIR`.
- arm64: every image SCAD builds or pulls is multi-arch (node, postgres,
  caddy, busybox) and builds natively on the VM.

**Needs founder (T3.1):** Oracle account and VM, DuckDNS name, Gmail app
password; then (1) `dig +short hello.you.<name>.duckdns.org` returns the VM
IP (two-level names), (2) the phone-on-mobile-data check with a real email,
(3) gVisor for real (`SCAD_OCI_RUNTIME=runsc`, closes Blocked #6), (4)
`deploy/firewall.sh` on the real VM and the adversarial suite there (INV1 on
Linux: an app container must not reach the host's port 4000 or SSH). None of
these could run here.

**T3.6 notes.** `POST /v1/apps/:id/rollback`, `scad rollback <app>`, MCP
`rollback`. New column `apps.current_release_id` (migration 0009, with down)
so "current" survives a rollback: a successful build sets it, rollback moves
it back, and resolve (port), env redeploys, and wake all serve it. Rolling back
twice goes two versions back (not a toggle). `/data` is never touched; env
vars are today's. Audit row `app.rollback`. Real Docker e2e: publish
`counter-sqlite`, publish a broken update, roll back through MCP, the old
code answers and the counter kept counting. **Needs founder:** the stage 6
check itself (publish a broken change and undo it by asking the agent); the
checkbox stays unticked until then. Merge note: track B may also add a
migration numbered 0009; renumber whichever lands second.

**T3.5 notes.** `visibility` gains `public` (migration 0010; the down script
rebuilds the enum, so the down test now also accepts `DROP TYPE`). `scad
publish --public/--private`, `scad visibility <app> private|public`, MCP
`publish` `visibility` (asks first, private when unsure, omitted on republish
keeps the setting), and every publish result carries a plain `link` sentence.
Gateway: one `decideAccess` for HTTP and WebSocket; anonymous visitors of a
public site get no identity headers (INV3), `X-Robots-Tag: noindex, nofollow`
on every public response, 300 anonymous requests/min per IP per site.
Visibility and suspension are read fresh per request (INV9). Anonymous
WebSocket upgrades are not rate-limited (the WS path has no trusted client IP
behind Caddy); noted for later. Founder check (stage 5, a phone that isn't
signed in opens one site of each kind) needs the live server.

**T3.4 notes.** One pasted command:
`curl -fsSL https://api.<instance>/install.sh | sh -s -- --email you@example.com`.
The control plane serves `install.sh` (checks Node 22, plain-English messages)
and a one-file client (`pnpm build:install`: esbuild bundles the CLI and MCP
server; `scad.mjs mcp` runs the MCP server). `scad setup` logs in and
registers SCAD with Claude Code (`claude mcp add --scope user`) and Cursor
(merges `~/.cursor/mcp.json`). Remote `scad login`: the auth host has no
session of its own, so approval is by email from the control plane: an
operator gets a one-time link (hashed, single use, 10 minutes, GET only shows
a confirm page so mail scanners cannot approve; 5 emails per address per
15 minutes, 50 per hour per instance; same answer for non-operators). Loopback
approval still refuses anything that came through Caddy. `share` now emails
the friend the link (`emailed` in the result; best effort). Hints reworded
for not logged in, unknown site, build failed. New dev dependency: `esbuild`
0.25.12 (already in the lockfile via tsx) to build the one-file client.
`tests/e2e/src/install.test.ts` runs the real `install.sh` against a real
control plane with a fresh `HOME`, a fake `claude` on `PATH`, and a
`~/.cursor` folder, approves through the emailed link, and checks login,
both registrations, a second run, and the no-Node message. **Needs founder:**
the second-laptop check (a person who has never seen SCAD follows only
`docs/getting-started.md`), which also closes the M2 exit check; checkbox
unticked until then.

## Blocked: needs human

1. **Merges.** Merge #39 (T2.7), then #40 (T2.8), then #41 (T2.9). All
   target `dev`.
2. **M2 exit check.** A friend publishes and shares an app unaided (see M2
   exit status), and the T0.8 GitHub second-account 403 browser check.
3. **Dependency installs during builds (T2.4).** With `--network=none`,
   templates cannot `npm install` or `pip install` from the registries. Today
   Node apps with `dependencies` must be bundled (the CLI never uploads
   `node_modules/`), and Python packages must be vendored as `wheels/`. Both are
   refused with a clear hint. Options:
   - (a) **Keep it offline (current).** Simplest and safest; bundling or
     vendoring is the app author's job. The MCP tool description tells
     agents this.
   - (b) **Registry-only build network.** Give template builds (or all builds)
     a network that can reach only `registry.npmjs.org` / `pypi.org` /
     `files.pythonhosted.org` through the egress proxy. Normal installs then
     work, but builds gain network access (install scripts run untrusted code
     with that access). This widens what a published app's build may reach:
     AGENTS §15.
   - (c) **Two-stage build.** A separate, trusted "fetch" step downloads
     declared dependencies (no install scripts: `npm ci --ignore-scripts`,
     `pip download --only-binary`) into the context, then the normal
     `--network=none` build runs. Safer than (b), more work, and packages
     with native build steps still fail.
   - (d) **Let the CLI upload `node_modules/`** (opt-in), so local installs
     travel with the app. Easy, but uploads get big (100 MB cap) and native
     modules built on macOS will not run on Linux.
4. **Data retention / account erasure** (AGENTS §15). `scad admin delete-app`
   removes a user's apps and their data. The suspended `users` row, deleted
   app rows, and audit events are kept. Whether, and when, to anonymise or
   erase those is your call (`docs/runbook.md`).
5. **CPU cap.** Keep CPU weighted (`cpuShares`, current), or add a hard
   per-app cap? That would change an AGENTS §11 default (see T2.8 notes).
6. **gVisor on a real host.** The `runsc` path is unit-tested only (Docker
   Desktop for Mac has no gVisor). Check it on the Linux host chosen in M3.
7. **M3 (public hosting, domain, provider).** Not started, by rule. Needed
   before a friend can use the instance from their own machine.
8. The scheduled daily task is disabled. Its stored folder is the old path
   (`Desktop/Small Cloud`). If you re-enable it, update its folder first.
