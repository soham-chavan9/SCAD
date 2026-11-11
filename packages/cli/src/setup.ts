import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ScadClient } from "@scad/api-client";
import { loadConfig } from "./config.js";
import { loginWithDeviceCode } from "./login.js";

/** Runs a command without a shell (argv only); resolves with its exit code. */
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number; output: string }>;

export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 127) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });

export type SetupOptions = {
  /** The SCAD instance's API, e.g. https://api.myscad.duckdns.org */
  apiUrl: string;
  /** Operator email for the approval link; asked for when missing and a login is needed. */
  email?: string;
  askEmail?: () => Promise<string>;
  /** How agents start the MCP server: `<node> <bundle> mcp`. */
  mcpCommand: { command: string; args: string[] };
  configPath?: string;
  home?: string;
  run?: Runner;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  pollMs?: number;
};

export type SetupReport = {
  loggedIn: "already" | "now";
  claudeCode: "registered" | "not_installed" | "failed";
  cursor: "registered" | "not_installed" | "skipped_invalid_config";
};

/**
 * `scad setup` (T3.4), run by the one pasted install command: log in to the
 * instance (approval by email, so it works from any laptop) and register the
 * SCAD MCP server with Claude Code and Cursor. Safe to run again.
 */
export async function setup(opts: SetupOptions): Promise<SetupReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const run = opts.run ?? defaultRunner;
  const home = opts.home ?? homedir();
  const apiUrl = opts.apiUrl.replace(/\/$/, "");

  const loggedIn = (await alreadyLoggedIn(apiUrl, opts)) ? "already" : "now";
  if (loggedIn === "now") {
    const email = (opts.email ?? (await opts.askEmail?.()) ?? "").trim();
    if (!email.includes("@")) {
      throw new Error("SCAD needs your email address to log you in. Run the install command again and type it.");
    }
    await loginWithDeviceCode({
      apiUrl,
      email,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      onUserCode: ({ userCode, message }) => {
        log(`Your code is ${userCode.slice(0, 4)}-${userCode.slice(4)}.`);
        log(message ?? `Check ${email} for an approval email.`);
        log("Open the email, check the code matches, and press Approve. Waiting…");
      },
    });
    log("Logged in.");
  } else {
    log(`Already logged in to ${apiUrl}.`);
  }

  const claudeCode = await registerClaudeCode(run, opts.mcpCommand);
  log(
    claudeCode === "registered"
      ? "Added SCAD to Claude Code."
      : claudeCode === "not_installed"
        ? "Claude Code isn't installed here (no `claude` command); skipped it. Run this command again after installing it."
        : "Could not add SCAD to Claude Code automatically. Run: claude mcp add --scope user scad -- " +
          [opts.mcpCommand.command, ...opts.mcpCommand.args].join(" "),
  );
  const cursor = await registerCursor(home, opts.mcpCommand);
  if (cursor === "registered") log("Added SCAD to Cursor.");
  if (cursor === "skipped_invalid_config") log("Cursor's ~/.cursor/mcp.json isn't valid JSON, so it was left alone.");

  log("");
  log("All set. Restart Claude Code (or Cursor), open your website's folder, and say:");
  log('  "Publish this with SCAD and share it with friend@example.com"');
  return { loggedIn, claudeCode, cursor };
}

async function alreadyLoggedIn(apiUrl: string, opts: SetupOptions): Promise<boolean> {
  const config = await loadConfig(opts.configPath);
  if (!config || config.apiUrl.replace(/\/$/, "") !== apiUrl) return false;
  try {
    await new ScadClient({
      baseUrl: apiUrl,
      pat: config.pat,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    }).listApps();
    return true;
  } catch {
    return false;
  }
}

async function registerClaudeCode(run: Runner, mcp: SetupOptions["mcpCommand"]): Promise<SetupReport["claudeCode"]> {
  if ((await run("claude", ["--version"])).code !== 0) return "not_installed";
  // Replace an older registration (another instance or path); a missing one is fine.
  await run("claude", ["mcp", "remove", "--scope", "user", "scad"]);
  const added = await run("claude", ["mcp", "add", "--scope", "user", "scad", "--", mcp.command, ...mcp.args]);
  return added.code === 0 ? "registered" : "failed";
}

async function registerCursor(home: string, mcp: SetupOptions["mcpCommand"]): Promise<SetupReport["cursor"]> {
  const dir = join(home, ".cursor");
  const isDir = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) return "not_installed";
  const file = join(dir, "mcp.json");
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw !== null && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "skipped_invalid_config";
      config = parsed as typeof config;
    } catch {
      return "skipped_invalid_config";
    }
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), scad: { command: mcp.command, args: mcp.args } };
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return "registered";
}
