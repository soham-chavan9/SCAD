#!/usr/bin/env node --experimental-strip-types
import { Command } from "commander";
import {
  adminAudit,
  adminDeleteApp,
  adminInviteAdd,
  adminInviteRemove,
  adminInvites,
  adminSuspendApp,
  adminSuspendUser,
  adminUsage,
  adminUsers,
  formatUsage,
} from "./admin.js";
import { defaultConfigPath, loadConfig } from "./config.js";
import { loginWithDeviceCode } from "./login.js";
import { openApp } from "./open-app.js";
import { publishDir } from "./publish.js";
import { listEnv, parseAssignments, setEnv, unsetEnv } from "./env.js";
import { streamLogs } from "./logs.js";
import { listApps, listShares, setVisibility, shareApp, unshareApp } from "./share.js";

async function main(): Promise<void> {
  const program = new Command();
  program.name("scad").description("SCAD CLI").version("0.0.0");

  program
    .command("login")
    .description("Log in via device code and store a PAT")
    .option("--api-url <url>", "Control plane URL", process.env["SCAD_API_URL"] ?? "http://127.0.0.1:4000")
    .option(
      "--approve-email <email>",
      "Auto-approve device code (local/dev)",
      process.env["SCAD_APPROVE_EMAIL"],
    )
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(async (opts: { apiUrl: string; approveEmail?: string; config: string }) => {
      const config = await loginWithDeviceCode({
        apiUrl: opts.apiUrl,
        ...(opts.approveEmail ? { approveEmail: opts.approveEmail } : {}),
        configPath: opts.config,
        onUserCode: ({ userCode, verificationUri }) => {
          console.log(`User code: ${userCode}`);
          console.log(`Approve at: ${verificationUri}`);
          if (!opts.approveEmail) {
            console.log(
              `POST ${verificationUri} with JSON {"user_code":"${userCode}","email":"you@example.com"}`,
            );
          }
        },
      });
      console.log(`Logged in. Config written to ${opts.config}`);
      console.log(`API: ${config.apiUrl}`);
    });

  program
    .command("publish")
    .description("Publish a directory (Dockerfile, or package.json / requirements.txt / index.html)")
    .argument("[dir]", "Directory to publish", ".")
    .option("--name <slug>", "App slug override")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(async (dir: string, opts: { name?: string; config: string }) => {
      try {
        const result = await publishDir({
          dir,
          ...(opts.name ? { name: opts.name } : {}),
          configPath: opts.config,
          onStatus: (line) => console.log(line),
        });
        console.log(result.url);
      } catch (err) {
        if (err && typeof err === "object" && "envelope" in err) {
          const envelope = (err as { envelope: Record<string, unknown> }).envelope;
          console.error(JSON.stringify(envelope, null, 2));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  program
    .command("open")
    .description("Open a published app URL in the default browser")
    .argument("<app>", "App slug or id")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(async (app: string, opts: { config: string }) => {
      try {
        const result = await openApp({
          app,
          configPath: opts.config,
        });
        console.log(result.url);
      } catch (err) {
        if (err && typeof err === "object" && "envelope" in err) {
          const envelope = (err as { envelope: Record<string, unknown> }).envelope;
          console.error(JSON.stringify(envelope, null, 2));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  program
    .command("share")
    .description("Let someone open an app (by email; they need not have an account yet)")
    .argument("<app>", "App slug or id")
    .argument("[email]", "Viewer email")
    .option("--instance", "Let every signed-in user on this SCAD instance open it")
    .option("--allowlist", "Back to allowlist only (the default)")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(
      handleErrors(
        async (
          app: string,
          email: string | undefined,
          opts: { instance?: boolean; allowlist?: boolean; config: string },
        ) => {
          if (opts.instance || opts.allowlist) {
            const visibility = opts.instance ? "instance" : "allowlist";
            const out = await setVisibility({ app, visibility, configPath: opts.config });
            console.log(`${out.slug}: visibility=${out.visibility}`);
          }
          if (email) {
            const out = await shareApp({ app, email, configPath: opts.config });
            console.log(`Shared ${app} with ${out.email}`);
          } else if (!opts.instance && !opts.allowlist) {
            throw new Error("Pass an email, or --instance / --allowlist");
          }
        },
      ),
    );

  program
    .command("unshare")
    .description("Remove someone's access to an app (applies within seconds)")
    .argument("<app>", "App slug or id")
    .argument("<email>", "Viewer email")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(
      handleErrors(async (app: string, email: string, opts: { config: string }) => {
        const out = await unshareApp({ app, email, configPath: opts.config });
        console.log(out.removed ? `Removed ${out.email} from ${app}` : `${out.email} had no access to ${app}`);
      }),
    );

  program
    .command("ls")
    .description("List your apps, or the viewers of one app")
    .argument("[app]", "App slug or id")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(
      handleErrors(async (app: string | undefined, opts: { config: string }) => {
        if (app) {
          const shares = await listShares({ app, configPath: opts.config });
          console.log(`visibility: ${shares.visibility}`);
          for (const v of shares.viewers) console.log(v.email);
          return;
        }
        for (const a of await listApps({ configPath: opts.config })) {
          console.log(`${a.slug}\t${a.status}\t${a.visibility}\t${a.url}`);
        }
      }),
    );

  program
    .command("logs")
    .description("Print an app's runtime logs (stdout and stderr). Owner only.")
    .argument("<app>", "App slug or id")
    .option("-f, --follow", "Keep streaming new lines")
    .option("-n, --tail <lines>", "Lines of history to show first", "100")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(
      handleErrors(async (app: string, opts: { follow?: boolean; tail: string; config: string }) => {
        const tail = Number(opts.tail);
        if (!Number.isInteger(tail) || tail < 0) throw new Error("--tail must be a whole number");
        await streamLogs({
          app,
          follow: opts.follow === true,
          tail,
          configPath: opts.config,
          onLine: (line) => console.log(line),
        });
      }),
    );

  const env = program.command("env").description("Manage an app's env vars and secrets");

  env
    .command("set")
    .description("Set env vars (KEY=value ...). The app restarts with them.")
    .argument("<app>", "App slug or id")
    .argument("<assignments...>", "KEY=value pairs")
    .option("--secret", "Store these values write-only: they can never be read back")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(
      handleErrors(async (app: string, assignments: string[], opts: { secret?: boolean; config: string }) => {
        const vars = parseAssignments(assignments);
        const out = await setEnv({ app, vars, secret: opts.secret === true, configPath: opts.config });
        console.log(`Set ${Object.keys(vars).join(", ")} on ${app}${opts.secret ? " (secret)" : ""}`);
        console.log(out.applied === "redeployed" ? "App restarted with the new env." : "Applies on the next publish.");
      }),
    );

  env
    .command("unset")
    .description("Remove env vars")
    .argument("<app>", "App slug or id")
    .argument("<keys...>", "Keys to remove")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(
      handleErrors(async (app: string, keys: string[], opts: { config: string }) => {
        await unsetEnv({ app, keys, configPath: opts.config });
        console.log(`Removed ${keys.join(", ")} from ${app}`);
      }),
    );

  env
    .command("ls")
    .description("List env vars (secret values are never shown)")
    .argument("<app>", "App slug or id")
    .option("--config <path>", "Config path", defaultConfigPath())
    .action(
      handleErrors(async (app: string, opts: { config: string }) => {
        for (const e of await listEnv({ app, configPath: opts.config })) {
          console.log(e.secret ? `${e.key}=<secret>` : `${e.key}=${e.value}`);
        }
      }),
    );

  // Operator commands (T2.6). Users: id or email. Apps: id or <owner-handle>/<slug>.
  const admin = program.command("admin").description("Operator controls (OPERATOR_EMAILS only)");
  const cfg = (c: Command) => c.option("--config <path>", "Config path", defaultConfigPath());

  cfg(admin.command("users").description("List every user with role and status")).action(
    handleErrors(async (opts: { config: string }) => {
      for (const u of await adminUsers({ configPath: opts.config })) {
        console.log(`${u.id}\t${u.email}\t${u.handle}\t${u.role}\t${u.status}`);
      }
    }),
  );
  for (const [name, suspended] of [["suspend-user", true], ["unsuspend-user", false]] as const) {
    cfg(admin.command(name).description(suspended ? "Suspend a user (blocked within 5 s; signs them out)" : "Lift a user's suspension"))
      .argument("<user>", "User id or email")
      .action(
        handleErrors(async (user: string, opts: { config: string }) => {
          const out = await adminSuspendUser({ user, suspended, configPath: opts.config });
          console.log(`${out.email}: ${out.status}`);
        }),
      );
  }
  for (const [name, suspended] of [["suspend-app", true], ["unsuspend-app", false]] as const) {
    cfg(admin.command(name).description(suspended ? "Suspend an app (blocked within 5 s; stops it)" : "Lift an app's suspension"))
      .argument("<app>", "App id or <owner-handle>/<slug>")
      .action(
        handleErrors(async (app: string, opts: { config: string }) => {
          const out = await adminSuspendApp({ app, suspended, configPath: opts.config });
          console.log(`${out.owner}/${out.slug}: ${out.status}`);
        }),
      );
  }
  cfg(admin.command("delete-app").description("Delete any app and its data (container, /data volume, env, logs, shares)"))
    .argument("<app>", "App id or <owner-handle>/<slug>")
    .option("--yes", "Confirm: this cannot be undone")
    .action(
      handleErrors(async (app: string, opts: { config: string; yes?: boolean }) => {
        if (!opts.yes) throw new Error(`This permanently deletes ${app} and its /data volume. Re-run with --yes.`);
        const out = await adminDeleteApp({ app, configPath: opts.config });
        console.log(`${out.owner}/${out.slug}: deleted`);
      }),
    );
  const invite = admin.command("invite").description("Who may create an account (besides OPERATOR_EMAILS and shared-to emails)");
  cfg(invite.command("add").description("Invite an email").argument("<email>")).action(
    handleErrors(async (email: string, opts: { config: string }) => {
      const out = await adminInviteAdd({ email, configPath: opts.config });
      console.log(out.created ? `Invited ${out.email}` : `${out.email} was already invited`);
    }),
  );
  cfg(invite.command("rm").description("Remove an invite (existing accounts are kept; suspend them to cut access)").argument("<email>")).action(
    handleErrors(async (email: string, opts: { config: string }) => {
      const out = await adminInviteRemove({ email, configPath: opts.config });
      console.log(out.removed ? `Removed invite for ${out.email}` : `${out.email} had no invite`);
    }),
  );
  cfg(invite.command("ls").description("List invites")).action(
    handleErrors(async (opts: { config: string }) => {
      for (const i of await adminInvites({ configPath: opts.config })) {
        console.log(`${i.email}\t${i.invited_by ?? "-"}\t${i.created_at}`);
      }
    }),
  );
  cfg(admin.command("usage").description("Per-app requests, unique viewers, last viewed, running hours, volume size"))
    .option("--days <n>", "Window for requests and viewers (1-35)", "30")
    .option("--json", "Print the raw JSON")
    .action(
      handleErrors(async (opts: { config: string; days: string; json?: boolean }) => {
        const report = await adminUsage({ configPath: opts.config, days: Number(opts.days) });
        console.log(opts.json ? JSON.stringify(report, null, 2) : formatUsage(report));
      }),
    );
  cfg(admin.command("page").description("Print the URL of the operator usage page"))
    .action(
      handleErrors(async (opts: { config: string }) => {
        const config = await loadConfig(opts.config);
        if (!config) throw new Error("Not logged in. Run `scad login` first.");
        console.log(new URL("/admin", config.apiUrl).toString());
      }),
    );
  cfg(admin.command("audit").description("Recent audit events, newest first"))
    .option("-n, --limit <n>", "How many (1-500)", "50")
    .option("--app <app>", "Only this app (id or <owner-handle>/<slug>)")
    .action(
      handleErrors(async (opts: { config: string; limit: string; app?: string }) => {
        const events = await adminAudit({
          configPath: opts.config,
          limit: Number(opts.limit),
          ...(opts.app ? { app: opts.app } : {}),
        });
        for (const e of events) {
          console.log(`${e.at}\t${e.action}\t${e.actor ?? "system"}\t${e.app_id ?? "-"}\t${JSON.stringify(e.metadata)}`);
        }
      }),
    );

  await program.parseAsync(process.argv);
}

/** Print §8 error envelopes as JSON and exit 1, rethrow anything else. */
function handleErrors<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      if (err && typeof err === "object" && "envelope" in err) {
        const envelope = (err as { envelope: Record<string, unknown> }).envelope;
        console.error(JSON.stringify(envelope, null, 2));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
