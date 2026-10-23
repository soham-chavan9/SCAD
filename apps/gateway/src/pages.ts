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
