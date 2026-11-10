# Runtime logs (T1.7)

```bash
scad logs my-app            # last 100 lines of stdout + stderr
scad logs my-app -f         # keep streaming new lines (Ctrl-C to stop)
scad logs my-app -n 500     # more history first
```

- **Owner only.** `GET /v1/apps/:id/logs` returns `404` for everyone else,
  including people the app is shared with (INV10).
- **Format.** The route is server-sent events: one `data: <line>` event per log
  line, then `event: end` when a non-follow read finishes. With `?follow=1` it
  keeps streaming and sends a `: keepalive` comment every 15 s. Query: `follow`
  (`1`/`true`), `tail` (0–10000, default 100).
- **Live.** The Docker driver decodes Docker's multiplexed stream incrementally,
  so lines show up as the app writes them (tested: lines in under 1 s while the
  container runs). When the client disconnects, the control plane stops reading
  and the Docker stream is closed on the next line, or when the app idle-stops.
- An app that has never deployed returns `NOT_FOUND` with a hint to publish.

## Where runtime logs live (T1.7b)

The control plane copies every app's stdout and stderr into its own Postgres
table, `runtime_logs` (`app_id`, `provider_id`, `at`, `line`). `scad logs` and
`GET /v1/apps/:id/logs` read only from that table. Docker's `json-file` driver is
just a small rotating buffer (2 x 1 MB per container) that the collector reads
from.

- **Collector.** One follow stream per running app. It attaches right after a
  wake or redeploy, and a sweep every 5 s picks up builder deploys and
  control-plane restarts. A container with nothing stored yet is read from its
  start (up to 10,000 lines). A container already in the store resumes with new
  lines only, so restarts don't duplicate lines. Lines written while the control
  plane is down and the app keeps running are not collected.
- **`-f`.** The route sends the last `tail` lines, then checks the table every
  300 ms for newer rows.
- **Flood cap.** At most 2,000 lines per app per 250 ms flush. Extra lines are
  counted and stored as one `[scad] N log lines dropped` line.
- **Secrets (INV12).** Before a line is stored, the value of each of the app's
  secret env vars (6 characters or longer) is replaced with `[redacted]`. The
  platform never writes tokens, cookies, or identity JWTs into the table.
- Rows are deleted with their app (`ON DELETE CASCADE`).

## Retention (AGENTS §14: 7 days)

| Log | Where | Retention |
|---|---|---|
| Runtime (stdout/stderr) | `runtime_logs` table | A control-plane job **deletes** rows older than 7 days (`pruneRuntimeLogs`). It runs at startup and then daily. Docker's own buffer is size-rotated at 2 x 1 MB. |
| Build logs | `$SCAD_DATA_DIR/logs/{releaseId}.log` | The same job deletes files not written for 7 days. |

Apps' own output is the owner's data, and only the owner can read it (INV10).
