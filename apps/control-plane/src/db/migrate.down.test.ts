import { readFileSync } from "node:fs";
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

const downDir = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle/down");

describe("reversible migrations", () => {
  it("ships a down script for each up migration", () => {
    for (const name of ["0000_init.down.sql", "0001_sessions_login_codes.down.sql"]) {
      const sqlText = readFileSync(join(downDir, name), "utf8");
      expect(sqlText).toMatch(/DROP TABLE/i);
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

      const down1 = readFileSync(join(downDir, "0001_sessions_login_codes.down.sql"), "utf8");
      const down0 = readFileSync(join(downDir, "0000_init.down.sql"), "utf8");

      await sql.begin(async (tx) => {
        for (const script of [down1, down0]) {
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
