#!/usr/bin/env node

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: pnpm --filter eve mcp:inspector-smoke <https://agent.example/mcp>");
  process.exit(1);
}

console.log(`Opening the official MCP Inspector for ${endpoint}`);
console.log("In Inspector, select Streamable HTTP, enter the URL, authenticate, then run:");
console.log("  1. initialize (protocol 2025-06-18)");
console.log("  2. tools/list");
console.log("  3. tools/call");

const child = await import("node:child_process");
const result = child.spawnSync("pnpm", ["dlx", "@modelcontextprotocol/inspector", endpoint], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
