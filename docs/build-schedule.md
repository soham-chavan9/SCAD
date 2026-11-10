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

## Blocked: needs human

1. Still open from T0.8: the GitHub second-account 403 browser check.
2. **Dependency installs during builds (T2.4).** With `--network=none`,
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
3. **gVisor on a real host.** The `runsc` path is unit-tested only (Docker
   Desktop for Mac has no gVisor). Check it on the Linux host chosen in M3.
4. If you pause or quit Docker Desktop, the scheduled run restarts it (it was
   not running at the start of Day 4).
