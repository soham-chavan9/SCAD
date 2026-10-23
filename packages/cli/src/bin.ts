#!/usr/bin/env node --experimental-strip-types
import { Command } from "commander";
import { defaultConfigPath } from "./config.js";
import { loginWithDeviceCode } from "./login.js";
import { publishDir } from "./publish.js";

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

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
