# Deploy SCAD on a free server (T3.1)

Takes a fresh Oracle Cloud Always Free VM to a live `https://` link. About an
hour, most of it waiting for installs. Everything runs on the one VM; the
only things listening on the internet are ports 80 and 443 (Caddy) and SSH.

```
 Internet ──443──> Caddy (TLS, on-demand certs) ──> gateway ──> app containers
                     │                                  │
                     └── api.{BASE_DOMAIN} ──> control plane (host :4000) <── builder (host)
                                                        │
                                                   Postgres (127.0.0.1:5432)
```

Names, all from `BASE_DOMAIN` (say `myscad.duckdns.org`):

| Host | What |
|---|---|
| `https://{slug}.{owner}.myscad.duckdns.org` | a published site |
| `https://auth.myscad.duckdns.org` | sign-in (magic link, optional GitHub) |
| `https://api.myscad.duckdns.org` | control plane for the CLI and MCP server |

## What the founder does (accounts and passwords)

You enter every card, password, and key yourself. Nothing here goes in the
repo; secrets live only in the server's `.env` (mode 600).

1. **Oracle Cloud account** (free tier; it asks for a card to check you're
   real, Always Free resources are not charged).
2. **A DuckDNS name** at <https://www.duckdns.org> (sign in, add a
   subdomain, e.g. `myscad`). Keep the DuckDNS token private.
3. **A Gmail app password**: Google Account → Security → 2-Step Verification
   on → App passwords → create one named "SCAD". Copy the 16 letters.

## 1. Create the VM

Oracle Cloud console → Compute → Instances → Create instance:

- Image: **Canonical Ubuntu 24.04** (aarch64).
- Shape: **Ampere VM.Standard.A1.Flex**, 2 OCPU and 12 GB memory (inside the
  Always Free allowance). If Oracle says "out of capacity", try another
  availability domain or retry later; this Mac is the fallback.
- Boot volume: 100 GB.
- Add your SSH public key. Create.

Networking → the instance's subnet → Security list → add ingress rules for
**TCP 80** and **TCP 443** (and **UDP 443** for HTTP/3) from `0.0.0.0/0`.
Leave everything else closed. Note the instance's **public IP**.

## 2. Point DuckDNS at the VM

On duckdns.org set your name's IP to the VM's public IP. Then check that
DuckDNS answers for two-level names, which SCAD needs for
`{slug}.{owner}.{name}.duckdns.org` (run on any machine):

```bash
dig +short hello.you.myscad.duckdns.org
```

It must print the VM's IP. If it prints nothing, stop: SCAD's host pattern
needs a different DNS provider.

## 3. Install Docker, Node, and pnpm on the VM

```bash
ssh ubuntu@<public-ip>
sudo apt-get update && sudo apt-get install -y ca-certificates curl git iptables-persistent
curl -fsSL https://get.docker.com | sudo sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo corepack enable && sudo corepack prepare pnpm@10.33.4 --activate
```

## 4. Get SCAD and write `.env`

```bash
sudo useradd -m -s /bin/bash scad && sudo usermod -aG docker scad
sudo mkdir -p /opt/scad /var/lib/scad/data /var/lib/scad/egress-policy
sudo chown -R scad:scad /opt/scad /var/lib/scad
sudo -iu scad
git clone https://github.com/soham-chavan9/small-cloud.git /opt/scad && cd /opt/scad
pnpm install --frozen-lockfile
bash deploy/setup-env.sh myscad.duckdns.org you@gmail.com
nano .env   # set SMTP_URL with your Gmail app password (format is in the file)
```

`deploy/setup-env.sh` generates the Postgres password, `INTERNAL_SECRET`,
`INTERNAL_TOKEN`, `MASTER_KEY`, and the Ed25519 JWT key pair. The `scad`
user is in the `docker` group, which is root-equivalent on this VM; only
SCAD's own services run as it.

## 5. Install gVisor (INV6)

Apps run under gVisor (`runsc`) on the server; `.env` sets
`SCAD_OCI_RUNTIME=runsc`, so SCAD refuses to start apps without it. As the
`ubuntu` user:

```bash
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install && sudo systemctl restart docker
docker info --format '{{json .Runtimes}}' | grep -q runsc && echo "gVisor ready"
```

## 6. Firewall

Oracle's Ubuntu image already refuses inbound traffic except SSH. Add SCAD's
rules (80/443 in; the control plane reachable only from Caddy and the
gateway; app containers reach no host service):

```bash
sudo bash /opt/scad/deploy/firewall.sh && sudo netfilter-persistent save
```

## 7. Start everything

```bash
sudo -iu scad
cd /opt/scad
docker compose -f deploy/compose.yml --env-file .env up -d --build
bash scripts/with-env.sh pnpm db:migrate
exit
sudo cp /opt/scad/deploy/systemd/scad-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scad-control-plane scad-builder
```

Check:

```bash
curl -s https://api.myscad.duckdns.org/healthz          # {"ok":true}
curl -sI https://auth.myscad.duckdns.org/login | head -1 # HTTP/2 200 (first call waits for the certificate)
sudo journalctl -u scad-builder -n 5                      # "apps run under runsc"
```

The first request to each new hostname waits a few seconds while Caddy gets
its certificate from Let's Encrypt. Caddy asks the control plane first
(`/internal/tls-ask`): only `auth.`, `api.`, and hosts of apps that exist get
one, so random names cannot use up Let's Encrypt limits. Each DuckDNS name
counts as its own registered domain for those limits (50 new certificates a
week), plenty for a few dozen sites.

## 8. Publish the first site

From your laptop, follow `docs/getting-started.md` (one pasted command), or
by hand:

```bash
export SCAD_API_URL=https://api.myscad.duckdns.org
scad login
scad publish examples/hello-static
```

Open the printed `https://hello-static.<you>.myscad.duckdns.org` on a phone
over mobile data, ask for a sign-in link, open the email, see the page.

## 9. Adversarial suite on the server

Run once after setup and after every upgrade, as `scad` in `/opt/scad`. The
suite uses its own `*_test` database, never the live one:

```bash
docker compose -f deploy/compose.yml --env-file .env exec -T postgres createdb -U scad scad_test
DATABASE_URL="postgres://scad:$(grep ^POSTGRES_PASSWORD= .env | cut -d= -f2)@127.0.0.1:5432/scad_test" pnpm test:adversarial
```

## Backups

`deploy/backup.sh` writes Postgres, a copy of `.env` (holds `MASTER_KEY` and
the JWT keys), every app's `/data` volume, and `SCAD_DATA_DIR` to
`backups/<date>/`. Copy it **off the server**. It is every secret in one
place: keep it on an encrypted disk or in a password manager's file vault.

```bash
ssh scad@<public-ip> 'cd /opt/scad && bash deploy/backup.sh'
scp -r scad@<public-ip>:/opt/scad/backups/$(date +%F) ~/scad-backups/
```

Restore: `docs/runbook.md` ("Restore"), with
`docker compose -f deploy/compose.yml --env-file .env` in place of
`docker compose`, and the backed-up `.env`.

## Upgrades

```bash
sudo -iu scad
cd /opt/scad && git pull && pnpm install --frozen-lockfile
docker compose -f deploy/compose.yml --env-file .env up -d --build
bash scripts/with-env.sh pnpm db:migrate
exit
sudo systemctl restart scad-control-plane scad-builder
```

## What is and is not exposed

| Thing | Reachable from |
|---|---|
| Caddy 80/443 | the internet |
| SSH 22 | the internet (Oracle default; key only) |
| Gateway :8080 | Caddy only (no published port) |
| Control plane :4000 | Caddy and the gateway (`172.31.250.0/24`) and the host; `/internal/*` is never proxied |
| Postgres :5432 | the host (`127.0.0.1`) and the platform network |
| Builder | nothing (it only calls out to the control plane) |
| App containers | the gateway; out only through the egress proxy |

Production refuses fake auth twice: `deploy/compose.yml` hard-codes
`GATEWAY_FAKE_AUTH=0`, and the gateway exits at start if it is on while
`NODE_ENV=production`. Local `scad login` approval is refused for any request
that came through Caddy (it carries forwarding headers), so a remote caller
never passes as localhost.

The gateway trusts `X-Forwarded-For` only from Caddy's pinned address
(`GATEWAY_TRUST_PROXY=172.31.250.10`), so per-IP sign-in limits see each
viewer's own IP. Caddy replaces whatever `X-Forwarded-For` a visitor sends.

## Local proof (no server needed)

`scripts/tls-smoke.sh` runs `deploy/Caddyfile` with Caddy's internal CA in
place of Let's Encrypt against the real ask endpoint, and checks that a live
app, `api.`, and `auth.` get certificates, unknown hosts get none, and
`/internal/*` is not reachable through `api.`:

```bash
DATABASE_URL=postgres://scad:scad@localhost:5432/scad bash scripts/tls-smoke.sh
```

## Troubleshooting

- **Certificate error on a new site:** the app must exist first (publish,
  then open). `docker compose -f deploy/compose.yml logs caddy | tail` shows
  the ask result.
- **Sign-in email never arrives:** check `SMTP_URL` (the `@` in your Gmail
  address is written `%40`) and the gateway log:
  `docker compose -f deploy/compose.yml logs gateway | tail`.
- **Oracle stopped the VM** (idle Always Free instances can be reclaimed):
  restore the latest backup on a new VM, or fall back to this Mac.
