import { createHash } from "node:crypto";

/**
 * Minimal operator page (T2.7, AGENTS §3 "the minimal operator page"). Static
 * HTML with no data in it. The script asks for an operator PAT, keeps it in
 * sessionStorage (this tab only, never in the URL), and renders
 * GET /v1/admin/usage with textContent only. The CSP allows exactly this
 * inline script (by hash) and same-origin fetches.
 */
const SCRIPT = `
const $ = (id) => document.getElementById(id);
const KEY = "scad-operator-pat";
function fmtBytes(n) {
  if (n === null || n === undefined) return "-";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}
function fmtTime(s) { return s ? new Date(s).toLocaleString() : "-"; }
function cell(tr, text) { const td = document.createElement("td"); td.textContent = String(text); tr.appendChild(td); }
async function load() {
  const pat = sessionStorage.getItem(KEY);
  $("login").hidden = Boolean(pat);
  $("data").hidden = !pat;
  if (!pat) return;
  $("status").textContent = "Loading...";
  const res = await fetch("/v1/admin/usage?days=" + encodeURIComponent($("days").value), {
    headers: { authorization: "Bearer " + pat },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("status").textContent = (body.message || "Request failed") + (body.hint ? " - " + body.hint : "");
    if (res.status === 401 || res.status === 403) sessionStorage.removeItem(KEY);
    return;
  }
  const rows = $("rows");
  rows.replaceChildren();
  for (const a of body.apps) {
    const tr = document.createElement("tr");
    cell(tr, a.owner + "/" + a.slug);
    cell(tr, a.status + (a.pinned ? " (pinned)" : ""));
    cell(tr, a.requests);
    cell(tr, a.unique_viewers);
    cell(tr, fmtTime(a.last_viewed_at));
    cell(tr, a.running_hours);
    cell(tr, fmtBytes(a.volume_bytes));
    cell(tr, fmtTime(a.expires_at));
    rows.appendChild(tr);
  }
  const t = body.totals;
  $("status").textContent = t.apps + " apps, " + t.running + " running, " + t.requests + " requests in " +
    body.window_days + " days, " + t.running_hours + " running hours, " + fmtBytes(t.volume_bytes) + " on volumes. Updated " +
    fmtTime(body.generated_at) + ".";
}
$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  sessionStorage.setItem(KEY, $("pat").value.trim());
  $("pat").value = "";
  load();
});
$("signout").addEventListener("click", () => { sessionStorage.removeItem(KEY); load(); });
$("days").addEventListener("change", load);
$("refresh").addEventListener("click", load);
load();
`;

const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");

export const OPERATOR_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${SCRIPT_HASH}'`,
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function operatorPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCAD operator</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fff; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; white-space: nowrap; }
  th { font-weight: 600; }
  td:nth-child(n+3):nth-child(-n+4), td:nth-child(6), td:nth-child(7) { text-align: right; }
  .bar { display: flex; gap: 12px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
  .wrap { overflow-x: auto; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } th, td { border-color: #333; } }
</style>
</head>
<body>
<h1>SCAD usage</h1>
<form id="login">
  <p>Paste an operator token (from <code>scad login</code>; see <code>~/.config/scad/config.json</code>). It stays in this tab only.</p>
  <input id="pat" type="password" autocomplete="off" required size="48" aria-label="Operator token">
  <button type="submit">Show usage</button>
</form>
<div id="data" hidden>
  <div class="bar">
    <label>Window <select id="days"><option value="1">1 day</option><option value="7">7 days</option><option value="30" selected>30 days</option></select></label>
    <button id="refresh" type="button">Refresh</button>
    <button id="signout" type="button">Forget token</button>
  </div>
  <p id="status" role="status"></p>
  <div class="wrap">
  <table>
    <thead><tr><th>App</th><th>Status</th><th>Requests</th><th>Unique viewers</th><th>Last viewed</th><th>Running hours</th><th>Volume</th><th>Expires</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  </div>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}
