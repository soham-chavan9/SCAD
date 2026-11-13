// Entry for the one-file SCAD client served by each instance (T3.4).
// `scad.mjs mcp` runs the MCP server for Claude Code / Cursor; anything else is the CLI.
if (process.argv[2] === "mcp") {
  process.argv.splice(2, 1);
  await import("../packages/mcp-server/src/bin.ts");
} else {
  await import("../packages/cli/src/bin.ts");
}
