# Docs

Canonical agent brief and build plan live at the repo root:

- [`../AGENTS.md`](../AGENTS.md) — decisions, contracts, security invariants
- [`../TASKS.md`](../TASKS.md) — ordered build plan

- [`build-isolation.md`](build-isolation.md) — how builds are isolated (INV8) and how to ship dependencies without `RUN`-time downloads
- [`sign-in.md`](sign-in.md) — GitHub and email magic-link sign-in on the auth host
- [`sharing.md`](sharing.md) — allowlists, `scad share`/`unshare`/`ls`, `visibility=instance`
- [`data-volume.md`](data-volume.md) — per-app `/data` volume lifecycle, permissions, and size limit
- [`manifest.md`](manifest.md) — `scad.json` fields, defaults, caps, and `MANIFEST_INVALID` errors
- [`secrets.md`](secrets.md) — `scad env`, write-only secrets, envelope encryption, `MASTER_KEY` rotation
- [`logs.md`](logs.md) — `scad logs -f`, the SSE logs route, and 7-day retention
- [`idle-wake.md`](idle-wake.md) — idle stop after 10 minutes, wake on request, the "Starting…" page
- [`operator.md`](operator.md) — `scad admin`: suspend apps and users, sign-up invites, audit log
- [`usage.md`](usage.md) — `scad admin usage` and the operator page (`/admin`)
- [`egress.md`](egress.md) — outbound network through the egress proxy and `EGRESS_ALLOWED_DOMAINS`
- [`../tests/adversarial/README.md`](../tests/adversarial/README.md) — adversarial suite: every attack scenario, its test, and its invariant
- [`build-schedule.md`](build-schedule.md) — daily build log, PR links, items blocked on the human

Threat model, runbook, and identity docs land in later tasks.
