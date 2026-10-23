import { Builder } from "./builder.js";

async function main(): Promise<void> {
  const controlPlaneUrl = process.env["SCAD_API_URL"] ?? process.env["PUBLIC_BASE_URL"] ?? "http://127.0.0.1:4000";
  const internalToken = process.env["INTERNAL_TOKEN"] ?? "dev-internal-token";
  const pollMs = Number(process.env["BUILDER_POLL_MS"] ?? 500);

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

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
