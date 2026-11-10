# Operator runbook (T2.9)

For one SCAD instance on one machine (local or a single host). Commands run
from the repo root with `.env` loaded: prefix them with
`bash scripts/with-env.sh`, or run `eval "$(python3 scripts/load-dotenv.py .env)"`
once per shell. `scad` below means `pnpm exec tsx packages/cli/src/bin.ts`,
logged in as an operator (an email in `OPERATOR_EMAILS`).

## What holds state

| What | Where | Lose it and... |
|---|---|---|
| Users, apps, releases, shares, env (encrypted), sessions, audit, usage, runtime logs | Postgres (`DATABASE_URL`; Compose volume `<project>_postgres_data`) | everything is gone |
| `MASTER_KEY` | `.env` (and your backup) | encrypted env vars and secrets can't be decrypted |
| App data | one Docker volume per app: `scad-data-{appId}` | that app's `/data` is gone |
| Upload tarballs, build logs | `SCAD_DATA_DIR` (default `./.scad-data`) | old uploads and build logs are gone; running apps are fine |
| Images | the local Docker image store | the app fails to wake until it is republished |
| Egress policy files | `SCAD_EGRESS_POLICY_DIR` (default `~/.scad/egress-policy`) | rewritten on every deploy; safe to lose |
| JWT signing key | `.env` (`JWT_PRIVATE_KEY`), else a new key on every gateway start | apps refetch the JWKS; nothing is stored |

## Back up

Do all three together, while nobody is publishing:

```bash
day=$(date +%F); mkdir -p "backups/$day"
docker compose exec -T postgres pg_dump -U scad -Fc scad > "backups/$day/scad.pgdump"
for v in $(docker volume ls -q --filter label=scad.app_id); do
  docker run --rm -v "$v":/v:ro -v "$PWD/backups/$day":/out busybox:1.36 tar -C /v -czf "/out/$v.tgz" .
done
tar -C "${SCAD_DATA_DIR:-./.scad-data}" -czf "backups/$day/scad-data-dir.tgz" .
```

Keep `MASTER_KEY` apart from the dump (a password manager), never next to it:
the dump plus the key is every app secret in plain text.

## Restore

1. Stop writers: the control plane and builder (Ctrl-C), and
   `docker compose stop gateway`.
2. Restore Postgres into an empty database, then migrate (an older dump is
   brought up to the current schema):

   ```bash
   docker compose exec -T postgres dropdb -U scad --if-exists scad
   docker compose exec -T postgres createdb -U scad scad
   docker compose exec -T postgres pg_restore -U scad -d scad --no-owner < backups/<day>/scad.pgdump
   bash scripts/with-env.sh pnpm db:migrate
   ```

3. Restore each app volume you need (the name carries the app id):

   ```bash
   v=scad-data-<appId>
   docker volume create --label scad.app_id=<appId> "$v"
   docker run --rm -v "$v":/v -v "$PWD/backups/<day>":/in:ro busybox:1.36 sh -c "tar -C /v -xzf /in/$v.tgz"
   ```

4. Restore `SCAD_DATA_DIR` from `scad-data-dir.tgz`.
5. Put the **same** `MASTER_KEY` in `.env`, start the control plane and
   builder, and run `docker compose up -d`.
6. Apps whose container or image is gone fail to wake and are marked
   `missing` by the hourly orphan reaper (it only flags, never deletes; see
   `docs/lifecycle.md`). Their owners, or you, republish them.
7. Check: `scad admin usage` lists the apps, and one app opens in a browser.

## Rotate keys and secrets

| Secret | How | Impact |
|---|---|---|
| `MASTER_KEY` | two-key rotation, then the `rotate-master-key` rewrap (`docs/secrets.md`) | none |
| JWT signing key | `JWT_PREVIOUS_PUBLIC_KEY` overlap, wait 10 min, drop it (`docs/identity.md`) | none |
| `INTERNAL_SECRET` (gateway to control plane) | new value (`openssl rand -hex 24`) in `.env`; restart the control plane, then `docker compose up -d gateway` | apps answer 5xx for the seconds the two differ |
| `INTERNAL_TOKEN` (builder to control plane) | new value in `.env`; restart the control plane, then the builder | builds wait until both match |
| `GITHUB_CLIENT_SECRET` | regenerate it in the GitHub OAuth app, update `.env`, `docker compose up -d gateway` | GitHub sign-in only |
| One user's PATs (`scad login` tokens) | `scad admin suspend-user <email>` refuses them at once; to revoke without suspending: `UPDATE pats SET revoked_at = now() WHERE user_id = '<id>';` | that user logs in again |
| Every gateway session | `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;` | everyone signs in again |

If `.env` may have leaked, rotate everything above, starting with `MASTER_KEY`
and `INTERNAL_SECRET`.

## Suspend, and delete a user's data

Suspending is instant and reversible (`docs/operator.md`):

```bash
scad admin suspend-user friend@example.com   # PATs refused, sessions revoked, their apps blocked and stopped
scad admin suspend-app olive/board           # one app only
scad admin unsuspend-user friend@example.com
```

To delete a user's data, suspend them first, then:

```bash
scad admin usage --json | jq -r '.apps[] | select(.owner == "<handle>") | "\(.owner)/\(.slug)"'
scad admin delete-app <handle>/<slug> --yes   # per app: container, /data volume, env, logs, shares
scad admin invite rm friend@example.com       # if they were invited
```

Each delete writes an `app.delete` audit row with reason `operator`. To also
remove their access to other people's apps, the owners run
`scad unshare <app> <email>` (or, as operator,
`DELETE FROM app_access WHERE email = '<email>';`).

What stays on purpose: the suspended `users` row (email, handle), the
`deleted` app rows, and the audit events, so the audit trail stays readable.
Erasing those as well (anonymising the account) is a data-retention decision
that hasn't been made yet (AGENTS §15). Until it is, don't delete `users` rows
by hand: audit rows and deleted apps point at them.

## Disaster reset (start over; all data is lost)

Only when you mean it: this removes every user, app, volume, and stored secret.

```bash
# 1. Stop the control plane and builder (Ctrl-C).
# 2. Services and the Postgres volume:
docker compose down -v
# 3. Every app container, network, and /data volume SCAD created:
docker ps -aq --filter label=scad.app_id | xargs docker rm -f
docker network ls -q --filter label=scad.app_id | xargs docker network rm
docker volume ls -q --filter label=scad.app_id | xargs docker volume rm
# 4. Uploads, build logs, and egress policy files:
rm -rf "${SCAD_DATA_DIR:-./.scad-data}" ~/.scad/egress-policy/*.json
# 5. Back up:
docker compose up -d && bash scripts/with-env.sh pnpm db:migrate
```

(On Linux add `-r` to each `xargs` so an empty list is a no-op.) Keep `.env`
to keep the same operators and keys; for a full reset, also delete `.env` and
run `bash scripts/setup-env.sh you@example.com`.

## Health checks

- `curl -s http://127.0.0.1:4000/healthz`: the control plane is up.
- `docker compose ps`: gateway, egress proxy, Postgres, and Mailpit are running.
- `scad admin audit -n 20`: recent changes. `runtime.orphan` rows mean Docker
  holds resources for an app the database doesn't know (`docs/lifecycle.md`).
- Docker refusing to create networks ("all predefined address pools have been
  fully subnetted") means leaked `scad-net-*` networks from crashed test runs:
  `docker network ls --format '{{.Name}}' | grep '^scad-net-' | xargs -n1 docker network rm 2>/dev/null`.
