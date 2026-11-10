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

## Blocked: needs human

1. **gh auth / PRs.** Run `gh auth login`, then push the four stacked branches
   and open PRs (or ask the agent to on the next run).
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
