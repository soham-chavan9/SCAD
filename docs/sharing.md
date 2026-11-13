# Sharing and allowlists (T1.2)

Every app starts **allowlist-only**: the owner and the emails on its
`app_access` list can open it. Nobody else can, even when signed in (403).

```bash
scad share my-app friend@example.com     # add an email (no account needed yet)
scad unshare my-app friend@example.com   # remove it; applies on the next request
scad ls                                  # your apps: slug, status, visibility, URL
scad ls my-app                           # visibility and viewer emails for one app
scad share my-app --instance             # any signed-in user on this instance
scad share my-app --allowlist            # back to the allowlist (default)
```

## How a friend gets in

1. You run `scad share my-app friend@example.com` and send them the URL.
2. They open it, choose "Email me a sign-in link" (or GitHub).
3. Magic link: because an app was shared with that email, a link is sent even
   though they have no account; their account is created when they use it.
   GitHub: the account's verified email is matched against the allowlist.
4. The gateway checks `app_access` by email on every request, so the first
   sign-in "links" the share to the new account with no extra step.

## API

| Route | Body | Result |
|---|---|---|
| `POST /v1/apps/:idOrSlug/share` | `{email}` | `201 {app_id, email}` (idempotent) |
| `DELETE /v1/apps/:idOrSlug/share/:email` | — | `{app_id, email, removed}` |
| `GET /v1/apps/:idOrSlug/share` | — | `{app_id, visibility, viewers: [{email, granted_at}]}` |
| `PATCH /v1/apps/:idOrSlug` | `{visibility: "allowlist" \| "instance" \| "public"}` | `{app}` |

The `GET .../share` and `PATCH /v1/apps/:id` routes are additions to the
AGENTS §8 list (needed for `scad ls <app>` and the `visibility=instance`
option).

Emails are trimmed and lowercased. Every share, unshare, and visibility change
writes an `audit_events` row (`app.share`, `app.unshare`, `app.visibility`).

## Ownership (INV10)

All four routes only find apps the caller owns. Someone else's app answers
`404 NOT_FOUND` (not 403), so app ids and slugs of other users are not
confirmed.

## Timing

The gateway caches `/internal/resolve` for 30 s (routing, status), but reads
`apps.visibility` and `app_access` from Postgres on every HTTP request and
WebSocket upgrade. Unshare and visibility changes therefore apply on the next
request (test: `apps/gateway/src/sharing.integration.test.ts`, under 5 s).

## Caution: `--instance`

`instance` means **every active user on this SCAD instance**. While GitHub
sign-in still creates an account for any GitHub user (see README warning), that
is effectively anyone with a GitHub account. Keep apps on the allowlist until
the invite allowlist lands.

## Public links (T3.5)

A site is **private** (`allowlist`) unless its owner chooses otherwise. Making
it **public** means anyone with the link sees it right away, no sign-in:

```bash
scad publish ./site --public          # publish and make the link public
scad publish ./site --private         # back to private (the default for new sites)
scad visibility my-site public        # switch without republishing
scad visibility my-site private
```

The MCP `publish` tool has a `visibility` field (`"private"` or `"public"`).
Its description tells the agent to ask *"private (only people you share it
with) or public (anyone with the link)?"* before a site's first publish, and
to use private when there is no clear answer. Republishing without it keeps
the current setting. Every publish result has a `link` sentence saying which
kind of link it is.

What the gateway does for a public site:

- **No sign-in.** Visitors without a session are served directly. A visitor
  who does have a session for that site (a friend who signed in while it was
  private) still gets the identity headers and JWT; an anonymous visitor's
  request carries none, and spoofed `X-SCAD-*` headers are always stripped
  (INV3).
- **Not for search engines.** Every response carries
  `X-Robots-Tag: noindex, nofollow`, replacing whatever the app sent.
- **Rate-limited for strangers.** Anonymous requests are limited to 300 a
  minute per IP per site (`429` with `Retry-After: 60`, a short page for
  browsers, `RATE_LIMITED` JSON otherwise). Signed-in viewers are not limited.
  Behind the TLS front the gateway sees each viewer's real IP
  (`GATEWAY_TRUST_PROXY`, `docs/deploy.md`). WebSocket upgrades are not
  counted against the limit.
- **Switching off is still immediate.** Visibility, app status, expiry, and
  the owner's status are read fresh on every request, so public → private, an
  operator suspend (INV9), or an expiry blocks the next request, and open
  WebSockets close within 2 s.
- Every visibility change writes an `app.visibility` audit row.
- Anonymous visits keep the site awake and renew its 30-day expiry, but do not
  count as viewers in `scad admin usage` (only signed-in viewers do).

Tests: `tests/adversarial/src/public-links.test.ts`.

