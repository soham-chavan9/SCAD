# Build isolation (T0.9, INV8)

SCAD builds every uploaded Dockerfile with:

```
docker build --network=none --progress=plain -t scad-apps/<appId>:v<version> <context>
```

(`apps/builder/src/docker-build.ts`.)

## What this means for app authors

**`RUN` steps have no network.** No `npm install`, `pip install`, `apk add`,
`apt-get`, `curl`, or `git clone` that downloads anything. The daemon still
pulls `FROM` base images, so any public base image works.

Ways to ship dependencies:

1. **Use only the standard library.** `examples/hello-node` and
   `examples/echo-identity` (Ed25519 JWT verification with `node:crypto`)
   need no packages.
2. **Vendor dependencies in a directory that gets uploaded.** `scad publish`
   and the builder skip `node_modules/` and `.git/`, so copy packages into
   something like `vendor/` (or a Python `wheels/` dir and
   `pip install --no-index --find-links wheels/ -r requirements.txt`, which
   works offline).
3. **Bundle.** Build a single file locally (esbuild, `pip download` + zipapp,
   a static `dist/`) and upload the output.
4. **Multi-stage with a pre-fetched dependency image.** `FROM` pulls are
   allowed, so a stage can `COPY --from=<some published image that already
   has your deps>`. The build still cannot download anything itself.

A build that tries the network fails in the `RUN` step (DNS lookups fail,
connections get "Network unreachable"). The `BUILD_FAILED` envelope carries
the last 50 log lines in `details.log_tail`.

## What the builder guarantees

| Check | Where | Test |
|---|---|---|
| `--network=none` on every build, no `--build-arg` / `--secret` / `--ssh` | `buildArgs()` | `apps/builder/src/docker-build.test.ts` |
| docker CLI child gets only `PATH`, `HOME`, `TMPDIR`, `DOCKER_*` | `buildEnv()` | same |
| builder process drops `MASTER_KEY`, `JWT_PRIVATE_KEY`, `GITHUB_CLIENT_SECRET`, `INTERNAL_SECRET`, `INTERNAL_TOKEN`, `DATABASE_URL`, `SMTP_URL` from its env at startup (after reading `INTERNAL_TOKEN`) | `scrubPlatformSecrets()` in `server.ts` | same |
| `scripts/m0-smoke.sh` starts the builder under `env -i` with only `PATH`, `HOME`, `DOCKER_HOST`, `INTERNAL_TOKEN`, `SCAD_API_URL` | smoke script | — |
| A `RUN` step cannot reach the control plane (:4000), Postgres (:5432), Mailpit (:1025/:8025), the gateway (:8080) via `host.docker.internal` or the bridge gateway IP, `169.254.169.254`, `1.1.1.1:443`, `8.8.8.8:53`, or DNS | real Docker | `tests/adversarial/src/inv8-build-isolation.test.ts` (with a control build on the default network that must reach Postgres, so the probe is known to work) |

## Still true / not covered

- The builder runs on the host and talks to the Docker daemon. It is trusted
  code; isolation is for the `RUN` steps it executes. A separate buildkitd or
  VM per build is a later hardening step, not M1.
- `INTERNAL_TOKEN` stays in the builder's memory (it needs it to claim jobs).
  It is not in the environment of any child process.
- Smoke checks run the built image with no env and a loopback-only published
  port; the runtime container then gets the hardened profile (INV6).
