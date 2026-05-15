#!/usr/bin/env node
/**
 * Entry point for the Arc MCP server.
 *
 * Usage:
 *   ARC_PRIVATE_KEY=0x... npx arc-mcp
 *
 * Or wire into Claude Desktop's claude_desktop_config.json — see src/mcp.ts.
 */

import "dotenv/config";
import type { Hex } from "viem";
import { startStdioServer } from "../src/mcp.js";

const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
if (!pk) {
  // Not fatal — server still serves reads. Log to stderr so it doesn't
  // pollute the stdio JSON-RPC stream.
  process.stderr.write(
    "[arc-mcp] ARC_PRIVATE_KEY not set — read-only mode. Send tools will refuse.\n",
  );
}

startStdioServer({
  privateKey: pk,
  rpcUrl: process.env.ARC_RPC_URL,
}).catch((err) => {
  process.stderr.write(`[arc-mcp] fatal: ${err}\n`);
  process.exit(1);
});
