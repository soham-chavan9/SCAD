# Sign-in (auth host)

The auth host is `auth.{BASE_DOMAIN}` (locally `http://auth.localhost:8080`).
An app host with no session redirects to `/login?return_to=<app URL>`, which
shows two options.

## GitHub (T0.6)

`/login/github?return_to=...` starts OAuth with `state` + PKCE.

## Email magic link (T1.1)

1. `POST /login/email` (form: `email`, `return_to`, `csrf`). CSRF is a
   double-submit cookie (`scad_csrf`, host-only, HttpOnly, SameSite=Lax) set by
   `GET /login`.
2. The response is the same "check your email" page whether or not the address
   can sign in, and the email is sent without awaiting it, so timing matches too
   (no account enumeration).
3. A link is only created and sent for an **existing, active user** with that
   email, or for an email some app has been shared with (T1.2). In the second
   case the account is created when the link is used (handle from the email's
   local part, e.g. `friend`, `friend-2`).
4. The link is `auth.{BASE_DOMAIN}/login/email/verify?token=...`. Opening it
   shows a "Continue" button; the token is consumed only by the `POST`, so mail
   scanners that prefetch links cannot burn it.
5. On success the auth host issues a one-time login code bound to the app host
   and redirects to `{app host}/__scad/callback`, the same as GitHub sign-in.

| Property | Value |
|---|---|
| TTL | 10 minutes (`MAGIC_LINK_TTL_MS`) |
| Use | single use (atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > now`) |
| At rest | SHA-256 of the token only (`magic_links.token_hash`) |
| Audience | bound to the app host in `return_to` (`magic_links.app_host`) |
| Rate limit | 5 requests / 15 min per email, 20 / 15 min per IP, applied to every request; over the limit returns `429` with `Retry-After` |
| Logs | the token and link are never logged (INV12) |

Rate limits are in memory in the gateway process (single instance). A restart
resets them.

## Local email

`docker compose up -d` starts Mailpit. The Compose gateway sends to
`smtp://mailpit:1025`; open <http://localhost:8025> to read the link. Host
processes and tests use `SMTP_URL=smtp://localhost:1025`.
