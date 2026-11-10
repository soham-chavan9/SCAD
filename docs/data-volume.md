# Persistent `/data` (T1.3, D6)

Each app gets one Docker named volume, `scad-data-{appId}`, mounted read-write
at `/data`. The root filesystem stays read-only (INV6); `/tmp` is a 64 MB tmpfs.
SQLite at `/data/app.db` is the recommended store (see `examples/counter-sqlite`,
which uses Node's built-in `node:sqlite`).

| Event | `/data` |
|---|---|
| stop / start (idle stop, wake) | kept |
| redeploy (`scad publish` again) | kept, mounted into the new release |
| `remove(appId, { deleteVolume: false })` | kept for the next `ensureApp` |
| `remove(appId, { deleteVolume: true })` | deleted |

## Permissions

Before every deploy the driver runs a trusted one-shot helper
(`busybox:1.36`, no network, read-only rootfs, caps limited to
`DAC_READ_SEARCH` + `FOWNER`) that makes the volume root `1777`, so whatever
non-root `USER` the image declares can write to `/data`. The volume is private
to the app's own container, so world-writable inside it exposes nothing.

## Size limit

`resources.disk_gb` in `scad.json` (default 1, cap 5) sets the limit.

Docker's `local` volume driver has **no size quota**: it cannot loop-mount a
sized image (`loop: invalid argument`, checked on Docker Desktop 29.9) and
`tmpfs` volumes are not persistent. So the Docker driver enforces a
**measured** limit:

- `deploy` and `start` measure `/data` (`du -sk`) first and throw
  `VolumeQuotaExceededError` if it is over. A refused deploy happens before the
  old container is removed, so the previous release keeps serving. The builder
  reports it as `LIMIT_EXCEEDED` with a hint.
- `enforceVolumeQuota(machine)` stops a running app that has grown past its
  limit (to be called by the lifecycle scheduler, T1.4/T2.5).

Between checks a running app can write past the limit.

**Decision (human, Nov 8): measured, not hard; revisit with the M3 provider.**
The measured limit is accepted for local use and M2. A hard limit needs a
different volume backend (Fly volumes in M3, or XFS project quotas / LVM on a
Linux host).

Tests: `packages/runtime-docker/src/volume.test.ts` (real Docker),
`apps/builder/src/deploy-error.test.ts`.
