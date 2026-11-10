# Operator controls and audit (T2.6)

Operators are users with an email in `OPERATOR_EMAILS` (or `role=operator` in
the database). Set `OPERATOR_EMAILS` for **both** the control plane and the
gateway (`.env` feeds both; Compose passes it to the gateway). Everyone else
gets `403 FORBIDDEN` from every `/v1/admin` route.

All commands take a user as an id or email, and an app as an id or
`<owner-handle>/<slug>` (the `scad admin usage` list shows both).

## Suspend and unsuspend

```bash
scad admin suspend-app olive/board      # viewers and the owner get 403; the app is stopped
scad admin unsuspend-app olive/board    # back to stopped; the next view wakes it
scad admin suspend-user friend@example.com
scad admin unsuspend-user friend@example.com
scad admin users                        # id, email, handle, role, status
```

- **Within 5 seconds (INV9).** The gateway reads app status, expiry, and the
  owner's status fresh on every request. Its 30 s resolve cache is only used
  for routing, so a suspend applies to the very next request. Open WebSockets
  re-check access every 2 seconds and are closed (both sides) when it is gone.
- **Suspending an app** stops its machine. The owner can't republish it
  (`403 APP_SUSPENDED`), env changes don't restart it, a build that was already
  running is kept as a release but the app stays stopped, and a build that
  had not started yet is cancelled.
- **Suspending a user** refuses their PATs (`401`), revokes their gateway
  sessions, blocks every app they own for all viewers, and stops those apps.
  Sign-in shows "Account suspended". You can't suspend yourself.
- Unsuspending a user doesn't restart their apps; the next view wakes each one.

## Sign-up invites

Only these may create an account (GitHub or magic link): `OPERATOR_EMAILS`,
emails some app was shared to, and the invite list. See `sign-in.md`.

```bash
scad admin invite add friend@example.com
scad admin invite ls
scad admin invite rm friend@example.com   # existing accounts are kept; suspend to cut access
```

## Audit log

Every publish, share, unshare, visibility change, env change, delete, suspend,
unsuspend, and invite change writes an `audit_events` row: actor, app, action,
time, and small metadata. Secrets, tokens, and env values are never stored in
it (INV7, INV12). System jobs (expiry, orphan reaper, quota stop) have no
actor.

```bash
scad admin audit -n 20
scad admin audit --app olive/board
```

| Action | Written by |
|---|---|
| `app.publish`, `app.create` | publish, internal create |
| `app.share`, `app.unshare`, `app.visibility` | share routes |
| `app.env.set` | `scad env set/unset` (key names only) |
| `app.delete` | owner delete or the expiry deleter |
| `app.suspend`, `app.unsuspend`, `user.suspend`, `user.unsuspend` | operator |
| `invite.add`, `invite.remove` | operator |
| `app.expiry_warning`, `app.expire`, `runtime.orphan`, `app.quota_stop` | lifecycle jobs |

## Usage

`scad admin usage` and the operator page at the control plane's `/admin`
show per-app requests, viewers, running hours, and volume size. See
[`usage.md`](usage.md).

## API

`GET /v1/admin/users`, `POST /v1/admin/users/:id/suspend|unsuspend`,
`POST /v1/admin/apps/:id/suspend|unsuspend` (URL-encode `owner/slug`),
`GET|POST /v1/admin/invites`, `DELETE /v1/admin/invites/:email`,
`GET /v1/admin/audit?limit=&app=`. See AGENTS.md §8.
