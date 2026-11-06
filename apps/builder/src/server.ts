import { Builder } from "./builder.js";
import { scrubPlatformSecrets } from "./docker-build.js";

async function main(): Promise<void> {
  const controlPlaneUrl = process.env["SCAD_API_URL"] ?? process.env["PUBLIC_BASE_URL"] ?? "http://127.0.0.1:4000";
  const internalToken = required("INTERNAL_TOKEN");
  const pollMs = Number(process.env["BUILDER_POLL_MS"] ?? 500);
  // INV8: the builder runs untrusted builds; hold no platform secrets in env.
  scrubPlatformSecrets(process.env);

  const builder = new Builder({
    controlPlaneUrl,
    internalToken,
  });

  console.log(`builder polling ${controlPlaneUrl} every ${pollMs}ms`);

  for (;;) {
    try {
      await builder.processNext();
    } catch (err) {
      console.error("builder tick error:", err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
