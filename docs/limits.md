# Limits and quotas (T2.3)

Defaults come from AGENTS §11 and §14; changing them needs the human's approval.
Every refusal is a §8 error with a `hint` that says what to do next.

| Limit | Value | When it trips | Response |
|---|---|---|---|
| Live apps | 10 per instance (one builder) | publishing a **new** app (or reviving a deleted/expired one) while 10 apps are `building`, `running`, `stopped`, or `suspended` | `403 LIMIT_EXCEEDED`, `details: {live_apps, max_live_apps}` |
| Upload | 100 MB tarball | publish body over the limit (the CLI also refuses before uploading) | `413 UPLOAD_TOO_LARGE` |
| Memory | `resources.memory_mb` cap 1024 (default 512) | manifest asks for more | `400 LIMIT_EXCEEDED`, `details.issues` names the field |
| Disk | `resources.disk_gb` cap 5 (default 1) | manifest asks for more | `400 LIMIT_EXCEEDED` |
| `/data` usage | the app's `disk_gb` | measured at deploy/start (`docs/data-volume.md`) | `LIMIT_EXCEEDED` on the release |
| Build time | 10 minutes | `docker build` still running | build killed; release `BUILD_FAILED` with `details.timed_out: true` and `log_tail` |
| Smoke check | 30 s | app not answering HTTP below 500 | `PORT_NOT_LISTENING` |

Notes:

- Republishing an app that already exists never counts against the live-app
  cap. Deleting an app (`DELETE /v1/apps/:id`, MCP `delete_app`) frees its
  slot right away.
- The count and the insert run under a Postgres advisory lock, so two
  concurrent publishes cannot both take the 10th slot.
- A timed-out build is cancelled in BuildKit too (the docker CLI gets
  SIGTERM and cancels the build; no `RUN` process is left running).
- Other bad manifest values (unknown keys, wrong types, `memory_mb: 0`) stay
  `MANIFEST_INVALID`.

Tests: `apps/control-plane/src/limits.integration.test.ts`,
`apps/builder/src/build-timeout.test.ts` (includes a real slow `docker build`).
