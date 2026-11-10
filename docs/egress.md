# Outbound network: the egress proxy (T2.1)

Apps have **no route to the internet** (INV2). Each app runs on its own
`internal: true` Docker network. The only way out is the egress proxy
(`scad-egress`, `apps/egress-proxy`), and only to domains that are:

1. listed in the app's `scad.json` `"egress"` (lowercase public hostnames like
   `api.github.com`, or `*.googleapis.com` for subdomains; no IPs, ports, or
   schemes; max 50), **and**
2. allowed by the operator's `EGRESS_ALLOWED_DOMAINS`.

## Operator policy: `EGRESS_ALLOWED_DOMAINS`

| Value | Meaning |
|---|---|
| `*` (default; unset or empty means the same) | Any public domain an app declares works. No separate approval step (human decision, Nov 9). |
| `api.github.com,*.googleapis.com` | Narrow: an app's declared domain works only if it also matches this list. |
| `none` | Refuse all egress, whatever apps declare. `none` must be used alone. |

Whatever the value, undeclared domains are refused, and a declared domain is
refused if **any** of its addresses is private, loopback, link-local, metadata,
or reserved (below). The proxy logs the active policy at startup, e.g.
`egress policy: apps may reach any domain an app declares in scad.json ...`.

## How an app uses it

The driver sets `HTTP_PROXY`, `HTTPS_PROXY` (and lowercase forms) to
`http://scad-egress:3128` in every app container. An app's own env can't
override them. Most HTTP clients pick these up (curl, Python `requests`,
Go). Node's `fetch` does not by default: use `undici`'s `EnvHttpProxyAgent`, or
on recent Node releases set `NODE_USE_ENV_PROXY=1`.

- HTTPS: `CONNECT host:443` (port 443 only).
- Plain HTTP: absolute-form requests to port 80.
- Anything else gets `403` with a plain-text reason, e.g. `SCAD egress refused
  github.com: host not in the app's scad.json egress list or not approved by
  the operator. Declare the domain in scad.json "egress" ...`

## What the proxy enforces

- **Who is asking.** The proxy is attached to every app network. When an app
  deploys, the driver writes `{appId, subnet, allow}` to
  `$SCAD_EGRESS_POLICY_DIR/{appId}.json` (default `~/.scad/egress-policy`). The
  proxy mounts that directory read-only and reloads it every second. The
  client's source IP falls in exactly one app subnet; an unknown source is
  refused. There is no admin port for an app to talk to.
- **DNS rebinding.** The proxy resolves the name itself. If **any** address is
  private, loopback, link-local, CGNAT, metadata (`169.254.169.254`, `fd00:ec2::254`),
  multicast, documentation, or IPv4-mapped, it refuses. Otherwise it connects
  to the address it vetted, never re-resolving.
- **Limits.** 128 concurrent connections per app, 10 s connect timeout, 5 min
  idle timeout.
- **Logs.** Only `app`, `host`, `port`, and the decision. Never paths, query
  strings, or headers (INV12).

## Running it locally

`docker compose up -d` starts `scad-egress` with the other services. Create the
policy directory first so Docker doesn't create it as root:

```bash
mkdir -p ~/.scad/egress-policy
```

The proxy reads this directory as the container user `node` (uid 1000), not
as you. The driver keeps it `0755`. On Linux, every parent directory must also
be traversable by uid 1000: a home directory with mode `0750` or `0700` blocks
it. In that case, set `SCAD_EGRESS_POLICY_DIR` to a path outside your home.
If the proxy can't read the directory, it logs `egress policy dir ... is
unreadable` and refuses all egress.

The default (`*`) needs no setup. To narrow or close egress, set it in `.env`,
then `docker compose up -d egress-proxy` to apply:

```
EGRESS_ALLOWED_DOMAINS=api.github.com,*.googleapis.com   # or: none
```

## Tests

- `apps/egress-proxy/src/proxy.test.ts`: blocked ranges, domain matching,
  CONNECT and HTTP forwarding, DNS rebinding with a fake resolver, unknown
  source, and the operator policy (T2.1b): with the default a declared public
  domain works, an undeclared one and a declared one resolving to a private IP
  are refused, `none` refuses everything, and a list narrows it.
- `tests/adversarial/src/inv2-egress-proxy.test.ts` (real Docker): through the
  proxy (running with the default policy) an app can't reach metadata, the host, the control plane, the Docker
  API port, another app, or an undeclared domain; an app with no `egress` gets
  nothing; direct connections still go nowhere; a declared domain works; and
  `localtest.me` (public DNS → 127.0.0.1) is refused. The last two need
  internet on the test machine and are skipped without it.
