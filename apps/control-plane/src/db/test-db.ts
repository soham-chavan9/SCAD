/**
 * Integration tests TRUNCATE every table. Never allow that against the dev
 * database named `scad`. CI and local tests must use a `*_test` database.
 * Ephemeral CI may instead set SCAD_ALLOW_DB_TRUNCATE=1.
 */
export function assertTruncateAllowed(databaseUrl: string): void {
  let name = "";
  try {
    name = new URL(databaseUrl).pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    name = "";
  }
  if (name.endsWith("_test")) return;
  if (process.env["SCAD_ALLOW_DB_TRUNCATE"] === "1") return;
  throw new Error(
    `Refusing to TRUNCATE database "${name || "(unparsed)"}". Point DATABASE_URL at a *_test database.`,
  );
}
