import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env["DATABASE_URL"];

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    return "";
  }
}

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const downDir = join(drizzleDir, "down");

/** Up migrations in order, e.g. ["0000_init", "0001_sessions_login_codes", ...]. */
function upMigrations(): string[] {
  return readdirSync(drizzleDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => f.replace(/\.sql$/, ""));
}

describe("reversible migrations", () => {
  it("ships a down script for each up migration", () => {
    expect(upMigrations().length).toBeGreaterThanOrEqual(3);
    for (const name of upMigrations()) {
      const sqlText = readFileSync(join(downDir, `${name}.down.sql`), "utf8");
      // A down script undoes its up script: tables it created, or columns it added.
      expect(sqlText, `${name}.down.sql`).toMatch(/DROP (TABLE|COLUMN)/i);
    }
  });
});

describe.runIf(Boolean(databaseUrl) && databaseName(databaseUrl ?? "").endsWith("_test"))(
  "down migrations roll back on a *_test database",
  () => {
    const sql = postgres(databaseUrl!, { max: 1 });

    afterAll(async () => {
      await sql.end({ timeout: 5 });
    });

    it("drops the schema inside a transaction and rolls back", async () => {
      await runMigrations(databaseUrl!);
      const before = await sql<{ users: string | null }[]>`
        SELECT to_regclass('public.users') AS users
      `;
      expect(before[0]?.users).toBe("users");

      const downs = upMigrations()
        .reverse()
        .map((name) => readFileSync(join(downDir, `${name}.down.sql`), "utf8"));

      await sql.begin(async (tx) => {
        for (const script of downs) {
          for (const stmt of script
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)) {
            await tx.unsafe(stmt);
          }
        }
        const gone = await tx<{ users: string | null }[]>`
          SELECT to_regclass('public.users') AS users
        `;
        expect(gone[0]?.users).toBeNull();
        throw new Error("ROLLBACK");
      }).catch((err: unknown) => {
        if (err instanceof Error && err.message === "ROLLBACK") return;
        throw err;
      });

      const after = await sql<{ users: string | null }[]>`
        SELECT to_regclass('public.users') AS users
      `;
      expect(after[0]?.users).toBe("users");
    });
  },
);
