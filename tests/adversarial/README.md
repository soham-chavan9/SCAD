# Adversarial suite (T2.8)

Every T2.8 scenario has a named test that says which invariant (AGENTS §12)
it defends. All of these run in CI as part of `pnpm test` (and alone with
`pnpm test:adversarial`). The Docker-backed files need a Docker daemon; the
identity file needs Postgres (`DATABASE_URL` pointing at a `*_test` DB).

Hostile sample apps live in `examples/adversarial/` and build offline
(`docker build --network=none`), like any published app.

| Scenario | Hostile app / attacker | Test | INV |
|---|---|---|---|
| Read another app's `/data` or env | `snoop` hunts `/proc/*/environ`, `/proc/*/cmdline`, and every readable file for a neighbour's secret (with a positive control) | `hostile-apps.test.ts` › reading another app's volume or env | 1, 7 |
| Read another app's env, logs, shares through the API | a second user with a valid PAT | `identity-and-sessions.test.ts` › another user's app through the API | 10 |
| Reach the control plane, Postgres, host, metadata IP, other apps | app container, directly and through the egress proxy | `inv2-egress-proxy.test.ts`, `packages/runtime-docker/src/invariants.test.ts` (INV1) | 1, 2 |
| Reach the Docker socket | `snoop` looks for docker/containerd sockets; driver config never mounts one | `hostile-apps.test.ts` › no Docker or containerd socket; `invariants.test.ts` (INV6 HostConfig) | 1, 8 |
| Exfiltrate to an undeclared host | app asks the proxy for `github.com`; DNS rebinding via `localtest.me` | `inv2-egress-proxy.test.ts` | 2 |
| Builds reach the network | a `RUN` step probes the control plane, Postgres, Mailpit, host, metadata, internet, DNS | `inv8-build-isolation.test.ts` | 8 |
| Spoof identity headers | client sends forged `X-SCAD-*` (email, id, name, JWT, extra) | `identity-and-sessions.test.ts` › spoofing identity headers | 3 |
| Forge or replay cookies | made-up, malformed, cross-app, revoked, and expired session cookies | `identity-and-sessions.test.ts` › forging or replaying cookies | 4 |
| Forge or replay login codes | replay, cross-host, expired, guessed codes; codes stored hashed | `identity-and-sessions.test.ts` › forging or replaying login codes | 5 |
| Exhaust pids | `fork-bomb` | `inv6-resource-limits.test.ts` | 6 |
| Exhaust memory | `memory-hog` (OOM-killed at its limit) | `inv6-resource-limits.test.ts` | 6 |
| Exhaust CPU | `cpu-hog` saturates every core; the neighbour still answers in under 1 s | `hostile-apps.test.ts` › a CPU hog cannot starve its neighbour | 6 |
| Exhaust disk | `disk-filler` writes to the rootfs (read-only), `/tmp` (64 MiB tmpfs), and `/data` (measured quota stops it); log buffer is capped | `hostile-apps.test.ts` › filling the disk | 6 |
| Abuse a public link | anonymous visitor with forged `X-SCAD-*` headers, forged and cross-app cookies, request floods; owner flips public → private; operator suspend | `public-links.test.ts` | 3, 4, 9 |
| Escape via privileged syscalls | `escape` tries setuid/setgid 0, rootfs write, chown to root, mount, mknod, chroot, user namespaces, raw sockets, ICMP out, sysrq, sysctl, kernel modules, exec from `/tmp`; checks CapEff=0, NoNewPrivs=1, seccomp on | `hostile-apps.test.ts` › escaping the sandbox | 6 |

Other invariants have their own named tests outside this folder:
INV7 (`apps/control-plane/src/secrets/crypto.test.ts`, `env.integration.test.ts`),
INV9 (`apps/gateway/src/operator-controls.integration.test.ts`: suspend within 5 s, open WebSockets closed),
INV11 (`apps/gateway/src/host.inv11.test.ts`, `packages/shared/src/validators.test.ts`),
INV12 (`apps/control-plane/src/runtime-log-store.integration.test.ts`, `env.integration.test.ts`).

## Known limits

- **CPU is weighted, not capped.** Each app gets `cpuShares` 1024 (AGENTS
  §11), so under contention it gets a fair share and cannot starve a
  neighbour, but an app alone on an idle host can use every core. A hard cap
  (`NanoCpus`) would change a default and is left for the human.
- **`/data` quota is measured, not hard** (accepted, Nov 8): an app can write
  past its limit until the 5-minute sweep stops it.
- **gVisor** is not available on Docker Desktop for Mac, so these run under
  `runc` with Docker's default seccomp profile.
- Plain `ping` works inside an app's own network via unprivileged ICMP
  sockets (Docker's default `ping_group_range`); raw sockets and ICMP to the
  internet are blocked.
