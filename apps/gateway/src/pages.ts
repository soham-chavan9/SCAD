export function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
<body>${body}</body>
</html>`;
}

export function notFoundPage(): string {
  return htmlPage("Not found", "<h1>404</h1><p>Unknown app host.</p>");
}

export function forbiddenPage(): string {
  return htmlPage("Forbidden", "<h1>403</h1><p>You do not have access to this app.</p>");
}

export function appReadyPage(slug: string, ownerHandle: string): string {
  return htmlPage(
    slug,
    `<h1 data-scad-app="${escapeHtml(slug)}">SCAD app</h1><p>${escapeHtml(slug)}.${escapeHtml(ownerHandle)} is ready.</p>`,
  );
}

/** Self-retrying page shown while a stopped app starts (§9 step 6). Reloads the same URL. */
export function wakingPage(failed = false): string {
  const message = failed
    ? "The app is taking longer than usual to start. This page will keep trying."
    : "Starting the app. This page reloads by itself in a moment.";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta http-equiv="refresh" content="2"/><title>Starting…</title></head>
<body><h1>Starting…</h1><p>${message}</p></body>
</html>`;
}

/** Sign-up refused by the invite allowlist (T2.6). */
export function notInvitedPage(): string {
  return htmlPage(
    "Not invited",
    `<h1>You're not invited yet</h1><p>This SCAD instance is invite-only. Ask the person who shared an app with you, or an operator, to invite your email address, then sign in again.</p>`,
  );
}

export function badCallbackPage(message: string): string {
  return htmlPage("Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function loginPage(opts: { returnTo: string; csrf: string }): string {
  const rt = escapeHtml(opts.returnTo);
  return htmlPage(
    "Sign in",
    `<h1>Sign in</h1>
<p><a href="/login/github?return_to=${escapeHtml(encodeURIComponent(opts.returnTo))}">Sign in with GitHub</a></p>
<form method="post" action="/login/email">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}"/>
<input type="hidden" name="return_to" value="${rt}"/>
<label>Email <input type="email" name="email" required autocomplete="email"/></label>
<button type="submit">Email me a sign-in link</button>
</form>`,
  );
}

/** Identical for known and unknown emails (no account enumeration). */
export function checkEmailPage(): string {
  return htmlPage(
    "Check your email",
    "<h1>Check your email</h1><p>If that address can sign in, a link is on its way. It works once and expires in 10 minutes.</p>",
  );
}

export function rateLimitedPage(): string {
  return htmlPage(
    "Too many requests",
    "<h1>Too many requests</h1><p>Wait a few minutes, then ask for a new link.</p>",
  );
}

/** Opening the link only shows this page; the POST consumes the token (mail scanners can't burn it). */
export function confirmMagicLinkPage(opts: { token: string; csrf: string }): string {
  return htmlPage(
    "Continue signing in",
    `<h1>Continue signing in</h1>
<form method="post" action="/login/email/verify">
<input type="hidden" name="token" value="${escapeHtml(opts.token)}"/>
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}"/>
<button type="submit">Continue</button>
</form>`,
  );
}
