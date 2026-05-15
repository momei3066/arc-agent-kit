/**
 * Smoke tests that don't require a private key or network.
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { arcAgentTools } from "../src/agent-tools.js";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_NATIVE_DECIMALS,
  USDC_ADDRESS,
  EURC_ADDRESS,
  arcTestnet,
  CCTP,
} from "../src/constants.js";
import { CCTP_DOMAINS, domainForChain } from "../src/cctp.js";
import { explorerLink, addressLink } from "../src/tools.js";
import { buildServer } from "../src/mcp.js";

test("Arc testnet chain config matches docs", () => {
  assert.equal(ARC_TESTNET_CHAIN_ID, 5042002);
  assert.equal(ARC_NATIVE_DECIMALS, 18);
  assert.equal(arcTestnet.id, 5042002);
  assert.equal(arcTestnet.nativeCurrency.symbol, "USDC");
  assert.equal(arcTestnet.testnet, true);
});

test("contract addresses are 20-byte hex", () => {
  const addrRe = /^0x[a-fA-F0-9]{40}$/;
  assert.match(USDC_ADDRESS, addrRe);
  assert.match(EURC_ADDRESS, addrRe);
  for (const [name, addr] of Object.entries(CCTP)) {
    assert.match(addr, addrRe, `CCTP.${name} should be a 20-byte address`);
  }
});

test("agent tool schemas declare required fields", () => {
  for (const tool of arcAgentTools) {
    assert.ok(tool.name, "tool has a name");
    assert.ok(tool.description.length > 20, `tool ${tool.name} has prose`);
    assert.equal(tool.input_schema.type, "object");
    assert.ok(
      Array.isArray(tool.input_schema.required),
      `tool ${tool.name} declares required fields`,
    );
  }
});

test("agent toolset covers core operations", () => {
  const names: Set<string> = new Set(arcAgentTools.map((t) => t.name));
  for (const expected of [
    "get_usdc_balance",
    "get_eurc_balance",
    "send_usdc",
    "send_eurc",
    "get_transaction_status",
  ]) {
    assert.ok(names.has(expected), `missing tool: ${expected}`);
  }
});

test("CCTP domain IDs match Circle's published list", () => {
  assert.equal(CCTP_DOMAINS.ethereum, 0);
  assert.equal(CCTP_DOMAINS.base, 6);
  assert.equal(CCTP_DOMAINS.solana, 5);
  assert.equal(domainForChain("ETHEREUM"), 0); // case-insensitive
  assert.equal(domainForChain("does-not-exist"), undefined);
});

test("explorer links are well-formed", () => {
  const tx = ("0x" + "a".repeat(64)) as `0x${string}`;
  const addr = ("0x" + "b".repeat(40)) as `0x${string}`;
  assert.ok(explorerLink(tx).startsWith("https://testnet.arcscan.app/tx/0x"));
  assert.ok(addressLink(addr).startsWith("https://testnet.arcscan.app/address/0x"));
});

test("MCP server builds without a private key (read-only mode)", () => {
  const server = buildServer({});
  assert.ok(server, "buildServer({}) returns an McpServer instance");
});
