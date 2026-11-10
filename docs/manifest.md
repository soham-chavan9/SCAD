# `scad.json` manifest (T1.5, AGENTS §11)

Put `scad.json` at the root of the directory you publish. Every field is
optional. `scad publish` uploads it inside the tarball; the control plane reads
it from the tarball root (`./scad.json`; files in subfolders are ignored), so
any client that uploads a tarball, including the MCP server, gets the same
behaviour.

```json
{
  "name": "sprint-tracker",
  "port": 3000,
  "start": "node server.js",
  "env": { "NODE_ENV": "production" },
  "egress": ["api.github.com"],
  "resources": { "memory_mb": 512, "disk_gb": 1 },
  "frame_ancestors": "self"
}
```

| Field | Default | Rules | Used for |
|---|---|---|---|
| `name` | dir name / `--name` | slug `[a-z0-9-]{3,40}` | app slug when `name=` is not sent |
| `port` | 8080 | 1–65535 | smoke check, container port, gateway upstream |
| `start` | image `CMD` | string, split into argv (quotes group words; no shell) | container entrypoint for smoke and deploy |
| `env` | `{}` | keys `[A-Za-z_][A-Za-z0-9_]*` (≤128 chars), values ≤32 KB | container env (smoke and deploy). Not for secrets: use `scad env set --secret` (see `secrets.md`) |
| `egress` | `[]` | lowercase public hostnames or `*.domain`, max 50 | enforced by the egress proxy, together with operator approval (see `egress.md`) |
| `resources.memory_mb` | 512 | integer, cap 1024 | container memory limit |
| `resources.disk_gb` | 1 | integer, cap 5 | `/data` size limit (see `data-volume.md`) |
| `frame_ancestors` | `self` | string | stored; gateway CSP lands later |

Unknown fields are rejected, so a typo like `"prot"` fails loudly instead of
being ignored.

## Errors

A bad manifest fails the publish request itself (no build starts) with `400`:

```json
{
  "code": "MANIFEST_INVALID",
  "message": "scad.json failed validation",
  "hint": "Fix \"resources.memory_mb\" in scad.json: memory_mb cap is 1024. See AGENTS §11 for fields, defaults, and caps.",
  "details": {
    "source": "scad.json",
    "issues": [{ "path": "resources.memory_mb", "message": "memory_mb cap is 1024" }]
  }
}
```

Invalid JSON and a `scad.json` over 64 KB are also `MANIFEST_INVALID`.

## Precedence

If the publish request has a `manifest` form field (API clients), it is used
instead of the tarball's `scad.json`. The resolved manifest, with §11 defaults
filled in, is stored on the release.
