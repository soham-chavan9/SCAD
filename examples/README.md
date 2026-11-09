# Examples

Sample apps used by later tasks. See `TASKS.md` Appendix A.

- `hello-node` — minimal HTTP server on port 8080 with a Dockerfile (T0.5).
- `echo-identity` — prints verified `X-SCAD-*` headers and optionally verifies the identity JWT against JWKS (T0.7).
- `counter-sqlite` — counts visits in SQLite at `/data/app.db` (built-in `node:sqlite`); data survives stop/start and redeploy (T1.3).
- `adversarial/fork-bomb` — hostile: starts a shell fork bomb; the pids limit must contain it (T2.2, INV6).
- `adversarial/memory-hog` — hostile: allocates memory forever; the memory limit (no swap) must OOM-kill only it (T2.2, INV6).
