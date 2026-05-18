/**
 * Demo: a Hono server that paywalls a single endpoint behind 0.001 USDC on Arc.
 *
 * Run:
 *   PAID_RECIPIENT=0x... PORT=8787 npx tsx examples/x402-server-demo.ts
 *
 * Then hit it:
 *   curl -i http://localhost:8787/paid/joke
 *   → 402 Payment Required, body = PaymentChallenge JSON
 *
 *   # pay (see examples/x402-end-to-end.ts for the automated client)
 *   curl -H "X-PAYMENT-PROOF: <base64>" http://localhost:8787/paid/joke
 *   → 200 + the actual joke
 *
 * The interesting bit is the verification — every paid request hits the
 * Arc testnet RPC to confirm the tx, the from/to/amount, and that the
 * (nonce, txHash) pair hasn't been seen before.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  ArcPaymentServer,
  type PaymentProof,
} from "../src/x402-server.js";

const PORT = Number(process.env.PORT ?? 8787);
const RECIPIENT = process.env.PAID_RECIPIENT as `0x${string}` | undefined;
const PRICE = process.env.PAID_PRICE ?? "0.001";

if (!RECIPIENT || !RECIPIENT.startsWith("0x")) {
  console.error(
    "Set PAID_RECIPIENT to the Arc testnet address that should receive payments.",
  );
  process.exit(1);
}

const server = new ArcPaymentServer({
  recipient: RECIPIENT,
  pricePerRequest: PRICE,
});

const app = new Hono();

app.get("/", (c) =>
  c.text(
    [
      "Arc x402 proof-of-payment demo server",
      `  paying recipient: ${RECIPIENT}`,
      `  price per request: ${PRICE} USDC`,
      "",
      "Try: curl -i http://localhost:" + PORT + "/paid/joke",
    ].join("\n"),
  ),
);

// Single paywalled endpoint. Anything served from here costs PAID_PRICE USDC.
app.get("/paid/joke", async (c) => {
  const proofHeader = c.req.header("x-payment-proof");
  const resource = "/paid/joke";

  if (!proofHeader) {
    const challenge = server.challenge(resource);
    return c.json(challenge, 402, {
      "WWW-Authenticate": `x402 scheme="arc-proof-of-payment"`,
    });
  }

  const proof: PaymentProof | null = ArcPaymentServer.decodeProofHeader(proofHeader);
  if (!proof) {
    return c.json({ error: "malformed X-PAYMENT-PROOF header" }, 400);
  }

  const result = await server.verify(proof, resource);
  if (!result.ok) {
    return c.json({ error: "payment verification failed", reason: result.reason }, 402);
  }

  return c.json({
    joke: "Why did the agent cross the Layer 1? Because the gas was cheap and the USDC was native.",
    paidBy: result.payer,
    paymentTx: result.txHash,
    explorer: `https://testnet.arcscan.app/tx/${result.txHash}`,
  });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`x402 demo server listening on http://localhost:${PORT}`);
  console.log(`Paywalled endpoint: GET /paid/joke (price: ${PRICE} USDC)`);
});
