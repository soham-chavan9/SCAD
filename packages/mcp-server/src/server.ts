import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ScadApiError, type ScadClient } from "@scad/api-client";
import type { PublishResult } from "@scad/cli";
import { z } from "zod";

export const TOOL_NAMES = [
  "publish",
  "list_apps",
  "get_app",
  "share",
  "unshare",
  "set_env",
  "get_logs",
  "delete_app",
] as const;

/** The API calls the tools need (a `ScadClient` satisfies it). */
export type ScadMcpClient = Pick<
  ScadClient,
  "listApps" | "getApp" | "shareApp" | "unshareApp" | "setEnv" | "streamLogs" | "deleteApp"
> &
  Partial<Pick<ScadClient, "listShares">>;

export type ScadMcpDeps = {
  client: ScadMcpClient;
  /** Pack `dir`, upload, and wait for the build (the CLI's `publishDir`). */
  publish: (dir: string, name?: string) => Promise<PublishResult>;
};

const ERRORS_COMMON =
  "UNAUTHENTICATED (run `scad login`), NOT_FOUND (no such app among yours: check list_apps), " +
  "VALIDATION_FAILED (bad input: see hint), RATE_LIMITED, INTERNAL. Every error is the SCAD envelope " +
  "{code, message, hint, details} as JSON; follow `hint`.";

const appRef = z
  .string()
  .min(1)
  .max(100)
  .describe("App slug (e.g. `sprint-tracker`) or app id, from list_apps.");

function ok(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/** Every failure becomes the §8 envelope so the agent always gets a `hint`. */
function fail(err: unknown): CallToolResult {
  let envelope: unknown;
  if (err instanceof ScadApiError) {
    envelope =
      "code" in err.envelope
        ? err.envelope
        : {
            code: "INTERNAL",
            message: err.envelope.error,
            hint: "Retry; if it persists, check the control plane logs.",
            details: {},
          };
  } else {
    const message = err instanceof Error ? err.message : "Unknown error";
    envelope = {
      code: "INTERNAL",
      message,
      hint: /log ?in/i.test(message)
        ? "Run `scad login` in a terminal, then retry."
        : "Retry; if it persists, check that the SCAD control plane is reachable.",
      details: {},
    };
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/** MCP tools wrapping the SCAD API (T1.8). Errors pass through the §8 envelope. */
export function createScadMcpServer(deps: ScadMcpDeps): McpServer {
  const server = new McpServer({ name: "scad", version: "0.1.0" });
  const { client } = deps;

  server.registerTool(
    "publish",
    {
      description:
        "Publish a local directory as a private SCAD app and wait until it is live. The directory needs a " +
        "Dockerfile (the image must run as a non-root USER and listen on the manifest port, default 8080), or " +
        "no Dockerfile and one of: package.json (Node; npm start / main / server.js), requirements.txt + app.py " +
        "(Python; packages only as vendored wheels/), or index.html (static site). Apps should listen on $PORT. An " +
        "optional scad.json sets name, port, start, env, and resources. Builds have NO network: dependencies must " +
        "be in the upload. Publishing an existing name replaces its release; if the new one fails, the old one " +
        "keeps serving. Inputs: dir (absolute path), name (optional slug, defaults to the folder name). Returns " +
        "{url, app_id, release_id}. Only people you `share` with can open the URL. Errors: BUILD_FAILED (read " +
        "details.log_tail and hint, fix, publish again), MANIFEST_INVALID (hint names the field), " +
        "PORT_NOT_LISTENING / SMOKE_CHECK_FAILED (app didn't answer HTTP on its port), UPLOAD_TOO_LARGE, " +
        `LIMIT_EXCEEDED, ${ERRORS_COMMON}`,
      inputSchema: {
        dir: z.string().min(1).describe("Absolute path of the app directory to publish."),
        name: z
          .string()
          .regex(/^[a-z0-9-]{3,40}$/)
          .optional()
          .describe("App name/slug: 3-40 chars of a-z, 0-9, -. Defaults to the directory name."),
      },
    },
    ({ dir, name }) =>
      run(async () => {
        const r = await deps.publish(dir, name);
        return { url: r.url, app_id: r.appId, release_id: r.releaseId, status: r.status };
      }),
  );

  server.registerTool(
    "list_apps",
    {
      description:
        "List the SCAD apps you own, newest first, with slug, url, status (building, running, stopped, " +
        "suspended, expired), visibility, and expiry. No inputs. Stopped apps wake automatically on the next " +
        `visit. Errors: ${ERRORS_COMMON}`,
      inputSchema: {},
    },
    () => run(() => client.listApps()),
  );

  server.registerTool(
    "get_app",
    {
      description:
        "Get one of your apps: url, status, visibility, expires_at, and the emails it is shared with. Input: " +
        `app (slug or id). Errors: ${ERRORS_COMMON}`,
      inputSchema: { app: appRef },
    },
    ({ app }) =>
      run(async () => {
        const detail = await client.getApp(app);
        if (!client.listShares) return detail;
        const shares = await client.listShares(app);
        return { ...detail, visibility: shares.visibility, viewers: shares.viewers.map((v) => v.email) };
      }),
  );

  server.registerTool(
    "share",
    {
      description:
        "Let someone open one of your apps by adding their email to its allowlist. They sign in with GitHub or " +
        "an email link using that address; they don't need an account yet. Takes effect within 5 seconds. " +
        `Inputs: app (slug or id), email. Errors: ${ERRORS_COMMON}`,
      inputSchema: { app: appRef, email: z.email().describe("Email address of the person to share with.") },
    },
    ({ app, email }) => run(() => client.shareApp(app, email)),
  );

  server.registerTool(
    "unshare",
    {
      description:
        "Remove an email from one of your apps' allowlist. They lose access within 5 seconds. Inputs: app (slug " +
        `or id), email. Returns removed=false if the email wasn't on the list. Errors: ${ERRORS_COMMON}`,
      inputSchema: { app: appRef, email: z.email().describe("Email address to remove.") },
    },
    ({ app, email }) => run(() => client.unshareApp(app, email)),
  );

  server.registerTool(
    "set_env",
    {
      description:
        "Set or remove environment variables for one of your apps. Values are encrypted at rest; keys listed in " +
        "`secret` become write-only (never shown again by any tool or API). A running app restarts with the new " +
        "values; otherwise they apply on the next publish. Inputs: app, vars ({KEY: value} to set, {KEY: null} " +
        "to remove; keys like MY_KEY), secret (optional list of keys to treat as secret). Returns key names only, " +
        `never values. Errors: VALIDATION_FAILED (bad key name), ${ERRORS_COMMON}`,
      inputSchema: {
        app: appRef,
        vars: z
          .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().nullable())
          .describe("Map of KEY to value (string) or null to remove the key."),
        secret: z.array(z.string()).optional().describe("Keys whose values are secret (write-only)."),
      },
    },
    ({ app, vars, secret }) =>
      run(async () => {
        const result = await client.setEnv(app, vars, secret ?? []);
        // Report key names only, even for non-secret vars.
        return { applied: result.applied, keys: result.env.map((e) => ({ key: e.key, secret: e.secret })) };
      }),
  );

  server.registerTool(
    "get_logs",
    {
      description:
        "Read recent stdout/stderr lines of one of your apps (kept 7 days), oldest first. Use it to debug an " +
        "app that is live but misbehaving; for a failed build, use the log_tail in the publish error instead. " +
        "Inputs: app, tail (number of lines, 1-1000, default 100). Errors: NOT_FOUND also means the app has " +
        `never been deployed. ${ERRORS_COMMON}`,
      inputSchema: {
        app: appRef,
        tail: z.number().int().min(1).max(1000).optional().describe("How many recent lines (default 100)."),
      },
    },
    ({ app, tail }) =>
      run(async () => {
        const lines: string[] = [];
        await client.streamLogs(app, { follow: false, tail: tail ?? 100 }, (line) => lines.push(line));
        return { lines };
      }),
  );

  server.registerTool(
    "delete_app",
    {
      description:
        "Permanently delete one of your apps: stops it, removes its container and its /data volume (all stored " +
        "data is lost), its env vars, its sharing list, and its logs. This cannot be undone; publishing the same " +
        "name later starts from scratch. Inputs: app, confirm (must be true). Errors: VALIDATION_FAILED (confirm " +
        `was not true), ${ERRORS_COMMON}`,
      inputSchema: {
        app: appRef,
        confirm: z.boolean().optional().describe("Must be true: confirms the app and its data should be deleted."),
      },
    },
    ({ app, confirm }) => {
      if (confirm !== true) {
        return fail(
          new ScadApiError(400, {
            code: "VALIDATION_FAILED",
            message: "delete_app needs confirm: true",
            hint: "Deleting removes the app and all its /data permanently. Ask the user, then call again with confirm: true.",
            details: {},
          }),
        );
      }
      return run(() => client.deleteApp(app));
    },
  );

  return server;
}
