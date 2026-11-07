# SCAD 5-day build schedule (agent notes)

Plan: Day 1 (Nov 6) T0.9, T1.1, T1.2, T1.3 · Day 2 T1.4–T1.7 · Day 3 T1.8, T1.9, T2.1 ·
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
"manually paused"); the agent ran `docker desktop restart` to resume it. The
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

## Blocked: needs human

1. **gh auth / PRs.** Run `gh auth login`, then push the eight stacked
   branches (T0.9 → T1.7) and open PRs in order, each based on its parent (or
   ask the agent to on the next run).
2. **Hard `/data` size limit (T1.3).** Docker local volumes cannot enforce a
   size (loop mounts are rejected; tmpfs is not persistent). Implemented a
   measured limit instead. Options: accept measured limits for local/M2; use XFS
   project quotas or LVM on a Linux host; rely on Fly volumes (M3). Your call.
3. **AGENTS §8 route list.** T1.2 added `GET /v1/apps/:id/share` and
   `PATCH /v1/apps/:id`. Approve and add them to AGENTS.md, or say how you want
   `scad ls <app>` and `visibility=instance` exposed instead.
4. **`visibility=instance` vs open GitHub sign-up.** While any GitHub user can
   create an account, `instance` means anyone with GitHub. Already listed in
   §14 as a pre-exposure fix (invite allowlist); flagging because T1.2 makes
   it reachable via `scad share --instance`.
5. Still open from T0.8: human GitHub second-account 403 browser check.
6. **More §8 route additions (T1.6, T1.7 notes).** `GET /v1/apps/:id/env`
   (lists keys; secret values never returned) was added alongside the §8
   `PUT`. Internal-only `POST /internal/builds/:id/runtime-env` was added for the
   builder. Approve and add them to AGENTS.md §8.
7. **Runtime log retention is a read window, not deletion (T1.7).** Docker's
   `json-file` driver cannot delete lines by age. Lines older than 7 days are
   never served, and disk is capped at 30 MB per container, but old lines stay
   on disk until rotation or redeploy. Options: accept this; switch to shipping
   logs to our own store with real TTL deletion; or restart idle containers
   weekly. Data retention policy is yours to decide (AGENTS §15).
8. **Docker Desktop was paused** when the Day 2 run started; the agent restarted
   it. If you pause it on purpose, the scheduled build cannot run its Docker
   tests.
