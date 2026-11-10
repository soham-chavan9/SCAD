# App lifecycle jobs (T2.5)

The control plane runs these on timers (`startLifecycleJobs` in
`apps/control-plane/src/lifecycle/jobs.ts`). Each job is idempotent, runs once
at start, never overlaps itself, and logs failures without stopping the
others. **Pinned apps are exempt** from warning, expiry, and deletion.

| Job | Cadence | What it does |
|---|---|---|
| Idle stopper | 1 min | stops running apps with no traffic for 10 minutes (T1.4) |
| Expiry notifier | daily | emails the owner once when `expires_at` is within 7 days (`app.expiry_warning` audit) |
| Expirer | 10 min | at `expires_at`: stops the machine, sets status `expired` (`app.expire`); the gateway then refuses the app |
| Expired-app deleter | 10 min | 14 days after `expires_at`: removes container, network, and `/data` volume; clears shares, env vars, and runtime logs; status `deleted` (`app.delete`, reason `expired`) |
| Orphan reaper | hourly | compares Docker (containers, networks, volumes labelled `scad.app_id`) with the DB; see below |
| Usage roll-up | hourly | folds per-viewer counters into `usage_daily` (requests, unique viewers) for today and yesterday (UTC) |

## Expiry clock (D8)

- **Publishing** sets `expires_at` to now + 30 days.
- **Viewing** renews it: every gateway touch (debounced to once per 30 s per
  app) sets `expires_at` to now + 30 days and re-arms the warning.
- Once an app is `expired`, a view does not bring it back; **republishing**
  does (the code returns, and so does `/data` if it has not been deleted yet).
- The warning email goes to the owner over `SMTP_URL` (Mailpit locally). If
  `SMTP_URL` is unset, the control plane only logs that it would have sent it.

## Orphan reaper

- **Orphans**: Docker resources for an app id with no live DB row (for
  example, leftovers from crashed tests). They are **flagged, not removed**,
  because the local daemon is shared with tests and other work. Each run
  writes a `runtime.orphan` audit row per orphan and logs a summary. Clean up
  by hand:

  ```bash
  docker network ls --format '{{.Name}}' | grep '^scad-net-' | xargs -n1 docker network rm 2>/dev/null
  ```

- **Missing**: DB machines (running or stopped) with nothing in Docker. Their
  `machines.state` becomes `missing`, so wakes report "republish".

## Usage

Touches add one request for that viewer and UTC day to `usage_viewers`. The
hourly roll-up recomputes `usage_daily.requests` (sum) and `unique_viewers`
(count) from those rows, so re-running never double counts. Raw rows are
kept 35 days. Requests are counted per gateway touch (at most one per 30 s per
app), not per HTTP request. `egress_bytes` stays 0 until the egress proxy
reports bytes. T2.7 reads these tables.

Tests: `apps/control-plane/src/lifecycle.integration.test.ts` (fake clock:
warn → stop → grace → delete, view renews, pinned exempt, reaper, usage),
`packages/runtime-docker/src/inventory.test.ts`.
