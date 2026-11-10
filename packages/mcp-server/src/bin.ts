#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ScadClient } from "@scad/api-client";
import { loadConfig, publishDir } from "@scad/cli";
import { createScadMcpServer } from "./server.js";

/**
 * `scad-mcp`: stdio MCP server. Uses the same login as the CLI
 * (`scad login` writes ~/.config/scad/config.json; SCAD_CONFIG overrides).
 * Never prints the token; stdout is reserved for the MCP protocol.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  const client = new ScadClient(config ? { baseUrl: config.apiUrl, pat: config.pat } : { baseUrl: "http://127.0.0.1:4000" });
  const server = createScadMcpServer({
    client,
    publish: (dir, name) => publishDir({ dir, ...(name ? { name } : {}) }),
  });
  if (!config) console.error("scad-mcp: not logged in; tools will return UNAUTHENTICATED until you run `scad login`.");
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error("scad-mcp failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
