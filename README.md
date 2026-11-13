# SCAD

Hosting layer for small software: publish an app, get a private URL, share it like a Google Doc. See [`AGENTS.md`](./AGENTS.md) for decisions and contracts, [`TASKS.md`](./TASKS.md) for the build plan.

## Run it end to end (about 15 minutes)

You need Node.js 22 and pnpm 10 (`corepack enable` gives you pnpm), Docker
Desktop (or Docker Engine) running, `openssl`, `python3`, and Chrome or
Firefox (they resolve `*.localhost`; see Hostnames for Safari).

```bash
git clone https://github.com/soham-chavan9/small-cloud.git && cd small-cloud
pnpm install
bash scripts/setup-env.sh you@example.com      # writes .env: you are the operator; secrets generated
mkdir -p ~/.scad/egress-policy
docker compose up -d --build                    # Postgres, Mailpit, gateway (:8080), egress proxy
bash scripts/with-env.sh pnpm db:migrate
```

Start the two host processes, each in its own terminal (they need the Docker socket):

```bash
bash scripts/with-env.sh pnpm --filter @scad/control-plane start   # :4000
```

```bash
bash scripts/with-env.sh pnpm --filter @scad/builder start
```

Then, in a third terminal, log in and publish the sample app:

```bash
bash scripts/with-env.sh pnpm exec tsx packages/cli/src/bin.ts login --approve-email you@example.com
bash scripts/with-env.sh pnpm exec tsx packages/cli/src/bin.ts publish examples/hello-node
```

`publish` prints the app's URL, e.g. `http://hello-node.you.localhost:8080`.
Open it, choose **Email me a sign-in link** with `you@example.com`, open the
link from Mailpit at <http://localhost:8025>, press **Continue**, and the app
loads. Share it with someone (`... share hello-node friend@example.com`) and
they can sign in the same way. See your instance with `... admin usage`.

`bash scripts/with-env.sh` loads `.env` for one command (values are parsed,
never executed). GitHub sign-in needs a GitHub OAuth app: set
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `.env` with callback
`http://auth.localhost:8080/oauth/github/callback`, then
`docker compose up -d gateway`.

To run the test suites instead: `pnpm lint && pnpm typecheck && pnpm test`
(needs Docker and a `scad_test` database: `docker compose exec postgres createdb -U scad scad_test`,
then `DATABASE_URL=postgres://scad:scad@localhost:5432/scad_test`), plus
`pnpm test:adversarial` and `pnpm test:e2e`.

Local services:

| Service | Port | Notes |
|---|---|---|
| Gateway | 8080 | apps at `http://{slug}.{owner}.localhost:8080`, sign-in at `http://auth.localhost:8080` |
| Control plane | 4000 | API, plus the operator usage page at `/admin` |
| Postgres | 5432 | `postgres://scad:scad@localhost:5432/scad` |
| Mailpit | 8025 | sign-in emails land here (SMTP on 1025) |

Operating it (backups, restore, key rotation, suspending and deleting users,
disaster reset): [`docs/runbook.md`](docs/runbook.md). Putting it on the
internet with `https://` links (a free VM, DuckDNS, Gmail):
[`docs/deploy.md`](docs/deploy.md). Using a deployed SCAD from your laptop
(one pasted command, then ask your AI): [`docs/getting-started.md`](docs/getting-started.md).

### Hostnames

Chrome and Firefox resolve `*.localhost` to loopback. Safari may not — use dnsmasq or `/etc/hosts` entries if needed. Auth will be at `http://auth.localhost:8080`. App hosts follow the pattern (not a URL) `http://{slug}.{owner}.localhost:8080` — e.g. `http://hello-node.<handle>.localhost:8080`.

## Workspace layout

```
apps/          control-plane, gateway, builder, egress-proxy
packages/      shared, cli, mcp-server, api-client, runtime-*
tests/         e2e, adversarial
examples/      hello-node, hello-python, hello-static, echo-identity, counter-sqlite, adversarial/*
deploy/        production Compose, Caddyfile, firewall, systemd units, backups
docs/          feature docs, runbook, build schedule (index: docs/README.md)
```

## Outbound network

Apps can only reach public domains they declare in `scad.json` `egress` (the default `EGRESS_ALLOWED_DOMAINS=*` allows any declared domain; set a comma list to narrow it, or `none` to refuse all egress); run `mkdir -p ~/.scad/egress-policy` before `docker compose up -d`. See `docs/egress.md`.

## Agents (MCP)

Run `scad login`, then point your agent at the `scad-mcp` stdio server: see `docs/mcp.md`.

## Common commands

| Command              | Purpose                |
|----------------------|------------------------|
| `pnpm install`       | Install workspace deps |
| `pnpm lint`          | ESLint                 |
| `pnpm typecheck`     | Strict `tsc -b`        |
| `pnpm test`          | Vitest (needs Docker + Postgres) |
| `pnpm format`        | Prettier write         |
| `pnpm db:migrate`    | Apply control-plane Drizzle migrations |
| `docker compose up -d` | Postgres, Mailpit, gateway |
| `pnpm exec tsx packages/cli/src/bin.ts login --approve-email you@example.com` | Device login (local) |
| `pnpm exec tsx packages/cli/src/bin.ts publish examples/hello-node` | Publish sample app (prints a real clickable URL) |
| `pnpm exec tsx packages/cli/src/bin.ts open hello-node` | Open a published app in the default browser |
| `pnpm exec tsx packages/cli/src/bin.ts share hello-node friend@example.com` | Let a friend open it (`unshare`, `ls` too; see [`docs/sharing.md`](docs/sharing.md)) |
| `pnpm exec tsx packages/cli/src/bin.ts env set hello-node API_TOKEN=... --secret` | Give the app env vars and write-only secrets (needs `MASTER_KEY`; see [`docs/secrets.md`](docs/secrets.md)) |
| `pnpm exec tsx packages/cli/src/bin.ts logs hello-node -f` | Stream the app's stdout/stderr (owner only; see [`docs/logs.md`](docs/logs.md)) |
| `bash scripts/m0-smoke.sh` | Browserless M0 exit checks (PASS/FAIL); no sudo (macOS Docker Desktop OK). Linux VMs with broken bridge ICC: `--vm-only` (refuses on macOS). |

Set `DATABASE_URL`, `INTERNAL_TOKEN`, `INTERNAL_SECRET`, and `OPERATOR_EMAILS` (see `.env.example`) before migrate/login. Run the control plane and builder on the host (`pnpm --filter @scad/control-plane start`, `pnpm --filter @scad/builder start`) when publishing outside tests. Gateway runs via Compose. Leave `GATEWAY_FAKE_AUTH` unset or `0` for real GitHub sign-in. `scripts/m0-smoke.sh` turns fake auth on for its own process only.

Sign-in: GitHub or an emailed magic link (see [`docs/sign-in.md`](docs/sign-in.md)).

Sign-up is invite-only (T2.6): only `OPERATOR_EMAILS`, emails an app was shared to, and emails on the operator's invite list (`scad admin invite add`) can create an account; operators can suspend apps and users (see [`docs/operator.md`](docs/operator.md)). **Public hosting is still a human decision (M3); keep it on localhost until then.** Builds run with `docker build --network=none` (T0.9, INV8): `RUN` steps cannot reach Postgres, the control plane, Mailpit, the host, or the internet, so **Dockerfiles must not download dependencies in `RUN` steps**. Vendor them, bundle them, or use only the standard library. See [`docs/build-isolation.md`](docs/build-isolation.md).
