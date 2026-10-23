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

Gateway (`8080`) comes in later tasks. Control plane + builder support `scad login` / `scad publish` (T0.5).

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
| `docker compose up -d` | Postgres + Mailpit   |
| `pnpm exec tsx packages/cli/src/bin.ts login --approve-email you@example.com` | Device login (local) |
| `pnpm exec tsx packages/cli/src/bin.ts publish examples/hello-node` | Publish sample app |

Set `DATABASE_URL` and `OPERATOR_EMAILS` (see `.env.example`) before migrate/login. Run the control plane and builder processes locally when publishing outside tests.
