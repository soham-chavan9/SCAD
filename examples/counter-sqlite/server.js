#!/usr/bin/env node
/**
 * Counts visits in SQLite at /data/app.db (the per-app persistent volume).
 * Uses Node's built-in node:sqlite, so the image needs no npm install and
 * builds with `docker build --network=none`.
 *
 * GET /       -> {"count": n}  (increments)
 * GET /peek   -> {"count": n}  (read only)
 */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.COUNTER_DB ?? "/data/app.db";

const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)");
db.exec("INSERT OR IGNORE INTO counter (id, n) VALUES (1, 0)");
const bump = db.prepare("UPDATE counter SET n = n + 1 WHERE id = 1 RETURNING n");
const read = db.prepare("SELECT n FROM counter WHERE id = 1");

createServer((req, res) => {
  const row = req.url === "/peek" ? read.get() : bump.get();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ count: row.n }));
}).listen(port, "0.0.0.0", () => {
  console.log(`counter-sqlite listening on ${port}, db ${dbPath}`);
});
