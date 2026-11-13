import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTruncateAllowed, buildApp, createDb, runMigrations, type Db } from "@scad/control-plane";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env["DATABASE_URL"];
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Mail = { to: string; subject: string; text: string };

/**
 * T3.4: a laptop that has never seen SCAD runs the one pasted command. It
 * gets the client from the instance, logs in by pressing Approve in an email,
 * and SCAD is registered with Claude Code and Cursor. Only `claude` is faked
 * (a script on PATH that records its arguments).
 */
describe.runIf(Boolean(databaseUrl))("one-command install on a fresh laptop (T3.4)", () => {
  let dbBundle: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let work: string;
  let apiUrl: string;
  let bundlePath: string;
  const sent: Mail[] = [];

  const instance = (publicBaseUrl: string) =>
    buildApp({
      db: dbBundle.db,
      dataDir: join(work, "data"),
      internalToken: "install-test",
      operatorEmails: ["founder@example.com"],
      publicBaseUrl,
      installBundlePath: bundlePath,
      mailer: { send: async (m) => void sent.push(m) },
    });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL required");
    assertTruncateAllowed(databaseUrl);
    await runMigrations(databaseUrl);
    dbBundle = createDb(databaseUrl);
    await dbBundle.db.execute(
      sql`TRUNCATE TABLE app_access, audit_events, machines, releases, pats, apps, users RESTART IDENTITY CASCADE`,
    );
    work = await mkdtemp(join(tmpdir(), "scad-install-"));
    bundlePath = join(work, "served", "scad.mjs");
    await execFileAsync(process.execPath, [join(REPO_ROOT, "scripts/build-install-bundle.mjs"), bundlePath]);

    // Find a free port, then start the instance with that URL baked into install.sh and the email links.
    const probe = await instance("http://127.0.0.1:1");
    await probe.listen({ port: 0, host: "127.0.0.1" });
    const addr = probe.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    await probe.close();
    apiUrl = `http://127.0.0.1:${addr.port}`;
    app = await instance(apiUrl);
    await app.listen({ port: addr.port, host: "127.0.0.1" });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await dbBundle?.client.end({ timeout: 5 });
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("installs, logs in by email, and registers with Claude Code and Cursor", async () => {
    const home = join(work, "home");
    const bin = join(work, "fakebin");
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    await mkdir(bin, { recursive: true });
    const claudeLog = join(work, "claude-calls.txt");
    await writeFile(join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${claudeLog}"\nexit 0\n`);
    await chmod(join(bin, "claude"), 0o755);
    const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };

    // The pasted command: curl -fsSL <api>/install.sh | sh -s -- --email founder@example.com
    const script = await (await fetch(`${apiUrl}/install.sh`)).text();
    expect(script).toContain(`API='${apiUrl}'`);
    const child = spawn("sh", ["-s", "--", "--email", "founder@example.com"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    child.stdin.end(script);
    const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));

    // The founder opens the email and presses Approve.
    const deadline = Date.now() + 60_000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(sent[0]?.to, output).toBe("founder@example.com");
    const link = new URL(/(http\S+\/v1\/auth\/device\/email\?token=\S+)/.exec(sent[0]!.text)![1]!);
    const approve = await fetch(`${apiUrl}/v1/auth/device/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: link.searchParams.get("token")! }).toString(),
    });
    expect(approve.status).toBe(200);

    expect(await exited, output).toBe(0);
    expect(output).toContain("Logged in.");
    expect(output).toContain("Added SCAD to Claude Code.");
    expect(output).toContain("Added SCAD to Cursor.");
    expect(output).toMatch(/Publish this with SCAD and share it with/);

    const installed = join(home, ".scad", "bin", "scad.mjs");
    const config = JSON.parse(await readFile(join(home, ".config", "scad", "config.json"), "utf8")) as {
      apiUrl: string;
      pat: string;
    };
    expect(config.apiUrl).toBe(apiUrl);
    const apps = await fetch(`${apiUrl}/v1/apps`, { headers: { authorization: `Bearer ${config.pat}` } });
    expect(apps.status).toBe(200);

    const calls = await readFile(claudeLog, "utf8");
    expect(calls).toContain(`mcp add --scope user scad -- ${process.execPath} ${installed} mcp`);
    const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(cursor.mcpServers["other"]).toEqual({ command: "x" });
    expect(cursor.mcpServers["scad"]).toEqual({ command: process.execPath, args: [installed, "mcp"] });

    // A second run skips the login; the wrapper runs the CLI.
    const again = await execFileAsync("sh", ["-c", script], { env });
    expect(again.stdout).toContain(`Already logged in to ${apiUrl}.`);
    const help = await execFileAsync(join(home, ".scad", "bin", "scad"), ["--help"], { env });
    expect(help.stdout).toContain("rollback");
  }, 120_000);

  it("explains plainly when Node.js is missing", async () => {
    const script = await (await fetch(`${apiUrl}/install.sh`)).text();
    const res = await execFileAsync("sh", ["-c", script], { env: { HOME: join(work, "nohome"), PATH: "/usr/bin:/bin" } }).then(
      (ok) => ({ code: 0, stdout: ok.stdout }),
      (err: { code: number; stdout: string }) => err,
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/needs Node\.js 22 or newer[\s\S]*nodejs\.org/);
  });

  it("refuses to hand out a client that was never built, with an operator hint", async () => {
    const other = await buildApp({
      db: dbBundle.db,
      dataDir: join(work, "data2"),
      internalToken: "install-test",
      publicBaseUrl: apiUrl,
      installBundlePath: join(work, "missing.mjs"),
    });
    const res = await other.inject({ method: "GET", url: "/install/scad.mjs" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ hint: expect.stringMatching(/pnpm build:install/) });
    await other.close();
  });
});
