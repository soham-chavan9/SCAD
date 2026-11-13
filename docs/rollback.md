# Rollback (T3.6)

"That update broke it, go back": one step returns a site to the version that
was live before the current one.

- MCP: `rollback` with `app`. CLI: `scad rollback <app>`. API:
  `POST /v1/apps/:id/rollback` (owner only; anyone else gets 404).
- The earlier image is started again with the app's **current** env vars.
  The app's `/data` volume is not touched, so saved data stays as it is now
  (a data change made by the broken version is not undone).
- "Current" is `apps.current_release_id`: a successful build sets it, and
  rollback moves it back. Rolling back again goes one more version back;
  failed releases are skipped. The next successful publish becomes current.
- With no earlier working version, the call fails with `VALIDATION_FAILED`
  and the hint "Fix the problem in the files and publish again instead."
- A suspended app cannot be rolled back (`APP_SUSPENDED`).
- Every rollback writes an `app.rollback` audit row with the from/to versions.

Tests: `apps/control-plane/src/rollback.integration.test.ts`, and a real
Docker run in `tests/e2e/src/mcp-agent.test.ts` (publish a counter site,
publish a broken update, roll back through MCP, the old code serves and the
`/data` counter carried on).
