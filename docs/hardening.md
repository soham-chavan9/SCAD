# Container hardening (T2.2, INV6)

Every app process (the deployed release and the builder's smoke check) runs
under one profile, built by `hardenedHostConfig` in
`packages/runtime-docker/src/hardening.ts`:

| Control | Setting |
|---|---|
| User | image must set a non-root `USER` (checked before the container starts; refused with `BUILD_FAILED` and a hint otherwise) |
| Root filesystem | read-only |
| Writable paths | `/tmp` (tmpfs, 64 MB, `noexec,nosuid,nodev`) and `/data` (the app's volume) |
| Capabilities | all dropped, none added; never privileged |
| Privilege gain | `no-new-privileges` |
| Memory | `resources.memory_mb` (default 512, cap 1024), **no swap** on top (`MemorySwap = Memory`), so a memory hog is OOM-killed |
| CPU | `cpuShares` 1024 (one CPU's weight) |
| Processes | 128 pids (fork bombs stop at the limit) |
| Network | the app's own `internal` network only; no published ports |
| Docker socket | never mounted |

## Smoke check

Before a release goes live, the builder runs the new image once with the same
profile, on the app's internal network (no internet, no host, and no egress
proxy), with a throwaway 64 MB tmpfs at `/data` so the live release's data is
never touched. A small busybox helper on that network sends `GET /`; the check
passes on any status below 500 within 30 s. Before T2.2 the smoke container
ran on Docker's default bridge with a published port, which gave untrusted
code internet and host access for up to 30 s.

## gVisor (`runsc`)

The driver asks Docker which runtimes it has, once per process:

- `SCAD_OCI_RUNTIME=auto` (default): use `runsc` when Docker lists it,
  otherwise Docker's default (`runc`). The builder logs which one at startup.
- `SCAD_OCI_RUNTIME=runsc`: require gVisor. Deploys and smoke checks fail if
  Docker has no `runsc` runtime.
- `SCAD_OCI_RUNTIME=runc`: never use gVisor.

Docker Desktop on macOS does not ship gVisor, so local development runs on
`runc` with the controls above. On a Linux host, install gVisor
(<https://gvisor.dev/docs/user_guide/install/>), register it with
`sudo runsc install` (adds a `runsc` entry to `/etc/docker/daemon.json`), and
restart Docker; SCAD then picks it up automatically. Check with
`docker info --format '{{json .Runtimes}}'`.

## Tests

- `packages/runtime-docker/src/hardening.test.ts`: the profile and the runtime choice.
- `packages/runtime-docker/src/invariants.test.ts` (INV6 case): a deployed
  container's real config.
- `packages/runtime-docker/src/smoke.test.ts`: the smoke container is sealed
  (with a positive control on the default bridge), cleans up, and refuses root
  images.
- `tests/adversarial/src/inv6-resource-limits.test.ts`:
  `examples/adversarial/fork-bomb` stays under its pids limit and
  `examples/adversarial/memory-hog` is OOM-killed, while a neighbour app keeps
  serving.
