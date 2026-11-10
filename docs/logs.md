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

## Retention (AGENTS §14: 7 days)

| Log | Where | Retention |
|---|---|---|
| Runtime (stdout/stderr) | Docker `json-file`, `max-size=10m`, `max-file=3` per container | The driver serves only lines from the last 7 days (`since`). Older lines stay on disk until Docker's size rotation drops them or the container is replaced on the next deploy, because `json-file` has no time-based deletion. |
| Build logs | `$SCAD_DATA_DIR/logs/{releaseId}.log` | A control-plane job deletes files not written for 7 days. It runs at startup and then daily. |

Apps' own output is the owner's data. The platform never writes tokens,
cookies, secrets, or identity JWTs into these logs (INV12; see `secrets.md`).
