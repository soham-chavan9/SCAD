# SCAD

Hosting layer for small software: publish an app, get a private URL, share it like a Google Doc. See [`AGENTS.md`](./AGENTS.md) for decisions and contracts, [`TASKS.md`](./TASKS.md) for the build plan.

## Requirements

- Node.js 22+
- [pnpm](https://pnpm.io) 10+
- Docker (Compose) for Postgres and Mailpit

## Quick start

```bash
cp .env.example .env
pnpm install
docker compose up -d
pnpm lint && pnpm typecheck && pnpm test
```

Local services after `docker compose up -d`:

| Service  | Port | Notes                          |
|----------|------|--------------------------------|
| Postgres | 5432 | `postgres://scad:scad@localhost:5432/scad` |
| Mailpit  | 8025 | SMTP UI (magic-link emails land here); SMTP on 1025 |

Control plane listens on `4000` on the host; gateway runs as the `scad-gateway` Compose service on `8080` (auth at `http://auth.localhost:8080`). Control plane + builder support `scad login` / `scad publish` (T0.5). The Docker runtime attaches that gateway container to each app network on deploy (T0.7).

### Hostnames

Chrome and Firefox resolve `*.localhost` to loopback. Safari may not — use dnsmasq or `/etc/hosts` entries if needed. Auth will be at `http://auth.localhost:8080`. App hosts follow the pattern (not a URL) `http://{slug}.{owner}.localhost:8080` — e.g. `http://hello-node.<handle>.localhost:8080`.

## Workspace layout

```
apps/          control-plane, gateway, builder, egress-proxy
packages/      shared, cli, mcp-server, api-client, runtime-*
tests/         e2e, adversarial
examples/      hello-node (more later)
docs/          pointers to AGENTS.md / TASKS.md; more docs later
```

## Outbound network

Apps can only reach domains declared in `scad.json` `egress` and approved in `EGRESS_ALLOWED_DOMAINS`; run `mkdir -p ~/.scad/egress-policy` before `docker compose up -d`. See `docs/egress.md`.

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

**Do not expose this off localhost yet.** GitHub sign-in creates an account for any GitHub user. `OPERATOR_EMAILS` only decides who may approve `scad login`. Builds run with `docker build --network=none` (T0.9, INV8): `RUN` steps cannot reach Postgres, the control plane, Mailpit, the host, or the internet, so **Dockerfiles must not download dependencies in `RUN` steps**. Vendor them, bundle them, or use only the standard library. See [`docs/build-isolation.md`](docs/build-isolation.md).
