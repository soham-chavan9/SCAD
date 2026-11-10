#!/usr/bin/env node --experimental-strip-types
import { Command } from "commander";
import { defaultConfigPath } from "./config.js";
import { loginWithDeviceCode } from "./login.js";
import { openApp } from "./open-app.js";
import { publishDir } from "./publish.js";
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
    .description("Publish a directory with a Dockerfile")
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
