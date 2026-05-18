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
import { X402_ARC_NETWORK, buildArcX402Client } from "../src/x402.js";
import {
  arcAgentToolsOpenAI,
  dispatchOpenAIToolCall,
} from "../src/openai-tools.js";
import { publicClient } from "../src/client.js";
import {
  createSubscription,
  parseDuration,
  setStatus,
  type SubscriptionStore,
} from "../src/recurring.js";
import {
  ArcPaymentServer,
  type PaymentProof,
} from "../src/x402-server.js";

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

test("x402 network identifier is Arc testnet's CAIP-2", () => {
  assert.equal(X402_ARC_NETWORK, "eip155:5042002");
});

test("x402 client builds against a throwaway test key", () => {
  // 32 bytes of 0x11 — deterministic test key, never funded, never used.
  const testKey = `0x${"11".repeat(32)}` as const;
  const { client, from } = buildArcX402Client(testKey);
  assert.ok(client, "buildArcX402Client returns an x402Client");
  assert.match(from, /^0x[a-fA-F0-9]{40}$/, "derives a valid address");
});

test("x402 client rejects malformed private keys", () => {
  assert.throws(
    () => buildArcX402Client("not-a-key" as `0x${string}`),
    /Invalid private key/,
  );
  assert.throws(
    () => buildArcX402Client("0x1234" as `0x${string}`),
    /Invalid private key/,
  );
});

test("agent toolset includes pay_x402", () => {
  const names = new Set<string>(arcAgentTools.map((t) => t.name));
  assert.ok(names.has("pay_x402"), "pay_x402 tool is registered");
});

test("OpenAI tool shape mirrors Anthropic shape 1:1", () => {
  // Same count, same names, same descriptions — only the wrapping shape differs.
  assert.equal(arcAgentToolsOpenAI.length, arcAgentTools.length);
  for (const ot of arcAgentToolsOpenAI) {
    assert.equal(ot.type, "function");
    assert.ok(ot.function.name);
    assert.ok(ot.function.description.length > 20);
    assert.equal(ot.function.parameters.type, "object");
    assert.ok(Array.isArray(ot.function.parameters.required));
    // The matching Anthropic tool exists with identical name + description.
    const anth = arcAgentTools.find((t) => t.name === ot.function.name);
    assert.ok(anth, `Anthropic counterpart found for ${ot.function.name}`);
    assert.equal(ot.function.description, anth!.description);
  }
});

test("recurring: parseDuration handles s/m/h/d and bare numbers", () => {
  assert.equal(parseDuration("30"), 30);
  assert.equal(parseDuration("30s"), 30);
  assert.equal(parseDuration("5m"), 300);
  assert.equal(parseDuration("1h"), 3600);
  assert.equal(parseDuration("2d"), 172800);
  assert.throws(() => parseDuration("xyz"));
});

test("recurring: createSubscription validates inputs", () => {
  const store: SubscriptionStore = { version: 1, subscriptions: [] };
  // Bad address
  assert.throws(() =>
    createSubscription(store, {
      to: "0xnotanaddress" as `0x${string}`,
      amount: "0.01",
      intervalSeconds: 3600,
    }),
  );
  // Bad amount
  assert.throws(() =>
    createSubscription(store, {
      to: ("0x" + "a".repeat(40)) as `0x${string}`,
      amount: "negative",
      intervalSeconds: 3600,
    }),
  );
  assert.throws(() =>
    createSubscription(store, {
      to: ("0x" + "a".repeat(40)) as `0x${string}`,
      amount: "0",
      intervalSeconds: 3600,
    }),
  );
  // Sub-minute intervals rejected (test guardrail)
  assert.throws(() =>
    createSubscription(store, {
      to: ("0x" + "a".repeat(40)) as `0x${string}`,
      amount: "0.01",
      intervalSeconds: 30,
    }),
  );
});

test("recurring: createSubscription + setStatus lifecycle", () => {
  const store: SubscriptionStore = { version: 1, subscriptions: [] };
  const sub = createSubscription(store, {
    to: ("0x" + "b".repeat(40)) as `0x${string}`,
    amount: "0.05",
    intervalSeconds: 3600,
    label: "test sub",
  });
  assert.match(sub.id, /^[a-f0-9]{12}$/);
  assert.equal(sub.status, "active");
  assert.equal(sub.ticks, 0);
  assert.equal(store.subscriptions.length, 1);

  setStatus(store, sub.id, "paused");
  assert.equal(store.subscriptions[0]!.status, "paused");

  setStatus(store, sub.id, "cancelled");
  assert.equal(store.subscriptions[0]!.status, "cancelled");

  assert.throws(() => setStatus(store, "nonexistent", "paused"));
});

test("x402 proof header round-trips through base64 JSON", () => {
  const proof: PaymentProof = {
    txHash: ("0x" + "1".repeat(64)) as `0x${string}`,
    nonce: "deadbeefcafef00d",
    payer: ("0x" + "a".repeat(40)) as `0x${string}`,
  };
  const encoded = ArcPaymentServer.encodeProofHeader(proof);
  const decoded = ArcPaymentServer.decodeProofHeader(encoded);
  assert.deepEqual(decoded, proof);
});

test("x402 proof header rejects malformed input", () => {
  assert.equal(ArcPaymentServer.decodeProofHeader("not-base64-and-not-json"), null);
  // valid base64 but not the expected JSON shape
  const garbage = Buffer.from(JSON.stringify({ foo: 1 }), "utf8").toString("base64");
  assert.equal(ArcPaymentServer.decodeProofHeader(garbage), null);
});

test("x402 server issues challenges that point at Arc testnet + the configured recipient", () => {
  const recipient = ("0x" + "b".repeat(40)) as `0x${string}`;
  const server = new ArcPaymentServer({
    recipient,
    pricePerRequest: "0.01",
  });
  const challenge = server.challenge("/paid/foo");
  assert.equal(challenge.scheme, "arc-proof-of-payment");
  assert.equal(challenge.network, "eip155:5042002");
  assert.equal(challenge.recipient, recipient);
  assert.equal(challenge.amount, "0.01");
  assert.equal(challenge.resource, "/paid/foo");
  assert.match(challenge.nonce, /^[0-9a-f]{32}$/);
  assert.ok(challenge.expiresAt > Date.now());
});

test("x402 server rejects verification with unknown nonce", async () => {
  const server = new ArcPaymentServer({
    recipient: ("0x" + "b".repeat(40)) as `0x${string}`,
    pricePerRequest: "0.01",
  });
  const bogus: PaymentProof = {
    txHash: ("0x" + "1".repeat(64)) as `0x${string}`,
    nonce: "never-issued",
    payer: ("0x" + "a".repeat(40)) as `0x${string}`,
  };
  const result = await server.verify(bogus, "/paid/foo");
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /unknown.*nonce/);
});

test("x402 server rejects a proof carrying the wrong resource for the nonce", async () => {
  const server = new ArcPaymentServer({
    recipient: ("0x" + "b".repeat(40)) as `0x${string}`,
    pricePerRequest: "0.01",
  });
  const challenge = server.challenge("/paid/a");
  const result = await server.verify(
    {
      txHash: ("0x" + "1".repeat(64)) as `0x${string}`,
      nonce: challenge.nonce,
      payer: ("0x" + "a".repeat(40)) as `0x${string}`,
    },
    "/paid/b",
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /different resource/);
});

test("OpenAI dispatcher parses JSON arguments and rejects malformed ones", async () => {
  const deps = { pub: publicClient() };
  // Malformed JSON → returns a tool message with an error, not throws.
  const result = await dispatchOpenAIToolCall(
    {
      id: "call_test_1",
      type: "function",
      function: { name: "get_usdc_balance", arguments: "{not json" },
    },
    deps,
  );
  assert.equal(result.role, "tool");
  assert.equal(result.tool_call_id, "call_test_1");
  const parsed = JSON.parse(result.content) as { error?: string };
  assert.match(parsed.error ?? "", /could not parse/);
});
