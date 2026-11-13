# MCP server (T1.8)

`@scad/mcp-server` lets a coding agent publish and manage SCAD apps over MCP.
It runs locally on stdio and uses the same login as the CLI.

```bash
scad login                                   # once; writes ~/.config/scad/config.json
pnpm --filter @scad/mcp-server start         # the scad-mcp stdio server
```

Example MCP client config:

```json
{
  "mcpServers": {
    "scad": { "command": "pnpm", "args": ["--dir", "/path/to/scad", "--filter", "@scad/mcp-server", "start"] }
  }
}
```

`SCAD_CONFIG` points it at a different config file. The token is never printed;
stdout carries only the MCP protocol.

## Tools

| Tool | Inputs | Does |
|---|---|---|
| `publish` | `dir` (absolute path), `name?`, `visibility?` (`private` \| `public`) | Packs, uploads, waits for the build; returns `{url, visibility, link, app_id, release_id}`. The agent asks private or public first; private when unsure (T3.5) |
| `list_apps` | — | Your apps with url, status, expiry |
| `get_app` | `app` | One app, plus `visibility` and `viewers` (shared emails) |
| `share` / `unshare` | `app`, `email` | Edit the allowlist (takes effect within 5 s); `share` emails the friend the link (`emailed`) |
| `set_env` | `app`, `vars` (`{KEY: value or null}`), `secret?` | Set or remove env vars; returns key names only |
| `get_logs` | `app`, `tail?` (1–1000) | Recent stdout/stderr lines from the log store |
| `delete_app` | `app`, `confirm: true` | Removes the app, its container, `/data`, env, shares, logs |
| `rollback` | `app` | Serves the previous working version again (T3.6); `/data` and env are kept |

`app` is a slug or an app id.

## Errors

A failed tool call returns `isError: true` with the AGENTS §8 envelope as JSON:
`{code, message, hint, details}`. Build failures include the last log lines in
`details.log_tail`.

Because builds run with `--network=none`, the builder spots download failures in
the log (DNS errors, `EAI_AGAIN`, pip `from versions: none`, …). The hint then
says to vendor dependencies instead of fetching them in a `RUN` step. The e2e
test `tests/e2e/src/mcp-agent.test.ts` drives a scripted agent through exactly
that: publish fails, the agent removes the downloading `RUN` line named in
`log_tail`, and the second publish succeeds.

`delete_app` refuses without `confirm: true`, so an agent has to ask first.

## Install on a laptop (T3.4)

Each instance serves its own client: `curl -fsSL https://api.<instance>/install.sh | sh -s -- --email you@example.com`
downloads one file (`/install/scad.mjs`, the CLI and this MCP server built
by `pnpm build:install`) to `~/.scad/bin`, logs in by an emailed approval
link, and registers `scad` with Claude Code (`claude mcp add --scope user`)
and Cursor (`~/.cursor/mcp.json`) as `node ~/.scad/bin/scad.mjs mcp`. See
`docs/getting-started.md`.

