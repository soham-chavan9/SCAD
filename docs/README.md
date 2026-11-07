# Docs

Canonical agent brief and build plan live at the repo root:

- [`../AGENTS.md`](../AGENTS.md) — decisions, contracts, security invariants
- [`../TASKS.md`](../TASKS.md) — ordered build plan

- [`build-isolation.md`](build-isolation.md) — how builds are isolated (INV8) and how to ship dependencies without `RUN`-time downloads
- [`sign-in.md`](sign-in.md) — GitHub and email magic-link sign-in on the auth host
- [`sharing.md`](sharing.md) — allowlists, `scad share`/`unshare`/`ls`, `visibility=instance`
- [`data-volume.md`](data-volume.md) — per-app `/data` volume lifecycle, permissions, and size limit
- [`idle-wake.md`](idle-wake.md) — idle stop after 10 minutes, wake on request, the "Starting…" page
- [`build-schedule.md`](build-schedule.md) — daily build log, PR links, items blocked on the human

Threat model, runbook, and identity docs land in later tasks.
