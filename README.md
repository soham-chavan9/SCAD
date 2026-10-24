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
| Mailpit  | 8025 | SMTP UI; SMTP on 1025          |

Control plane listens on `4000` on the host; gateway runs as the `scad-gateway` Compose service on `8080` (auth at `http://auth.localhost:8080`). Control plane + builder support `scad login` / `scad publish` (T0.5). The Docker runtime attaches that gateway container to each app network on deploy (T0.7).

### Hostnames

Chrome and Firefox resolve `*.localhost` to loopback. Safari may not — use dnsmasq or `/etc/hosts` entries if needed. Auth will be at `http://auth.localhost:8080`; apps at `http://{slug}.{owner}.localhost:8080`.

## Workspace layout

```
apps/          control-plane, gateway, builder, egress-proxy
packages/      shared, cli, mcp-server, api-client, runtime-*
tests/         e2e, adversarial
examples/      hello-node (more later)
docs/          pointers to AGENTS.md / TASKS.md; more docs later
```

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
| `pnpm exec tsx packages/cli/src/bin.ts publish examples/hello-node` | Publish sample app |
| `bash scripts/m0-smoke.sh` | Browserless M0 exit checks (PASS/FAIL); no sudo (macOS Docker Desktop OK). Linux VMs with broken bridge ICC: `--vm-only` (refuses on macOS). |

Set `DATABASE_URL`, `INTERNAL_TOKEN`, `INTERNAL_SECRET`, and `OPERATOR_EMAILS` (see `.env.example`) before migrate/login. Run the control plane and builder on the host (`pnpm --filter @scad/control-plane start`, `pnpm --filter @scad/builder start`) when publishing outside tests. Gateway runs via Compose. Leave `GATEWAY_FAKE_AUTH` unset or `0` for real GitHub sign-in. `scripts/m0-smoke.sh` turns fake auth on for its own process only.

**Do not expose this off localhost yet.** GitHub sign-in creates an account for any GitHub user. `OPERATOR_EMAILS` only decides who may approve `scad login`. A `RUN` instruction in a published Dockerfile can still reach Postgres, the control plane, Mailpit, and the host (T0.9, not started). No friend should publish until that is closed.
