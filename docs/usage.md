# Usage and cost visibility (T2.7)

Operators (`OPERATOR_EMAILS`) can see what every app costs to run:

```bash
scad admin usage              # last 30 days
scad admin usage --days 7     # 1 to 35
scad admin usage --json
scad admin page               # prints the operator page URL (control plane /admin)
```

| Column | Meaning | Source |
|---|---|---|
| Requests | gateway requests in the window | raw per-viewer counters (`usage_viewers`), so current, not only as of the hourly roll-up |
| Unique viewers | distinct signed-in users in the window | same |
| Last viewed | last gateway request | `apps.last_viewed_at` |
| Running hours | all-time container running time, including the current run | `machines.running_seconds` + the current run |
| Volume | last measured `/data` size | `machines.volume_bytes`, written by the 5-minute quota sweep |

Notes:

- Requests are counted per debounced gateway touch (T2.5), so a burst of
  requests from one viewer within the debounce window counts as one.
- **Running hours** are folded in whenever a machine stops, wakes, is
  redeployed, or is marked missing, so stopped time never counts. Hours from
  before this change (migration 0008) were not recorded.
- **Volume size** is measured only for running apps (a stopped app's volume
  can't grow). An app that has never run since the upgrade shows `-`.
- `usage_daily` (the hourly roll-up) is kept for history; the raw counters it
  is built from are kept 35 days.

## Operator page

`GET /admin` on the control plane (locally `http://127.0.0.1:4000/admin`) is
a single static page with the same table. It contains no data itself: it asks
for an operator token (the PAT in `~/.config/scad/config.json` after
`scad login`), keeps it in this browser tab only (`sessionStorage`, never in
the URL), and calls `GET /v1/admin/usage`. A non-operator token gets the 403
message. The page is served with a strict CSP (`default-src 'none'`, its one
inline script pinned by hash, same-origin fetches only), `no-store`, and
`frame-ancestors 'none'`.

## API

`GET /v1/admin/usage?days=30` returns `{window_days, since, generated_at, apps: [...], totals}`;
each app has `id, owner, slug, status, pinned, requests, unique_viewers,
last_viewed_at, running_hours, volume_bytes, volume_measured_at, expires_at`.
