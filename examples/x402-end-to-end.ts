/**
 * End-to-end demo: spin up the x402 server in-process, then have the
 * agent-side client hit it, pay, and read the unlocked content. Closes
 * the full HTTP-402 → on-chain payment → verification loop on Arc testnet.
 *
 * Run:
 *   ARC_PRIVATE_KEY=0x... PAID_RECIPIENT=0x... npx tsx examples/x402-end-to-end.ts
 *
 * Requires a funded Arc testnet wallet for the *payer*, and a different
 * address for the *recipient* (so we don't pay ourselves).
 */

import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import {
  ArcPaymentServer,
  type PaymentProof,
  paidFetch,
} from "../src/x402-server.js";
import { walletClient } from "../src/client.js";

const PAYER_KEY = process.env.ARC_PRIVATE_KEY as `0x${string}` | undefined;
const RECIPIENT = process.env.PAID_RECIPIENT as `0x${string}` | undefined;
const PRICE = process.env.PAID_PRICE ?? "0.001";

if (!PAYER_KEY || !PAYER_KEY.startsWith("0x")) {
  console.error("Set ARC_PRIVATE_KEY to a funded Arc testnet wallet.");
  process.exit(1);
}
if (!RECIPIENT || !RECIPIENT.startsWith("0x")) {
  console.error("Set PAID_RECIPIENT to an Arc testnet address (the merchant).");
  process.exit(1);
}

async function main() {
  const wallet = walletClient(PAYER_KEY!);
  const payer = wallet.account!.address;
  console.log(`Payer:     ${payer}`);
  console.log(`Recipient: ${RECIPIENT}`);
  console.log(`Price:     ${PRICE} USDC per request`);
  console.log("");

  // 1. Stand up the paywalled API in-process.
  const server = new ArcPaymentServer({
    recipient: RECIPIENT!,
    pricePerRequest: PRICE,
  });
  const app = new Hono();
  app.get("/paid/data", async (c) => {
    const proofHeader = c.req.header("x-payment-proof");
    const resource = "/paid/data";
    if (!proofHeader) {
      return c.json(server.challenge(resource), 402);
    }
    const proof: PaymentProof | null = ArcPaymentServer.decodeProofHeader(proofHeader);
    if (!proof) return c.json({ error: "malformed proof" }, 400);
    const result = await server.verify(proof, resource);
    if (!result.ok) {
      return c.json({ error: "verify failed", reason: result.reason }, 402);
    }
    return c.json({
      secret: "Arc is the economic OS for autonomous agents.",
      paidBy: result.payer,
      paymentTx: result.txHash,
    });
  });

  const httpServer = serve({ fetch: app.fetch, port: 0 });
  const port = (httpServer.address() as AddressInfo).port;
  const url = `http://localhost:${port}/paid/data`;
  console.log(`Server up at ${url}`);

  try {
    // 2. Client side — fire the request. paidFetch handles the 402 dance.
    console.log("\n[1] Sending unpaid GET — expecting 402…");
    const peek = await fetch(url);
    console.log(`    status: ${peek.status} (${peek.statusText})`);

    console.log("\n[2] Retrying with paidFetch — this sends a real Arc USDC tx…");
    const t0 = Date.now();
    const response = await paidFetch(url, undefined, {
      wallet,
      maxAmount: "0.01",
    });
    const elapsedMs = Date.now() - t0;

    console.log(`    status: ${response.status} after ${elapsedMs}ms`);
    const body = await response.json();
    console.log(`    body:`);
    console.log("   ", JSON.stringify(body, null, 2).split("\n").join("\n    "));

    if (response.status === 200 && (body as { paymentTx?: string }).paymentTx) {
      console.log(`\n✅ End-to-end success.`);
      console.log(
        `   Arcscan: https://testnet.arcscan.app/tx/${(body as { paymentTx: string }).paymentTx}`,
      );
    } else {
      console.error("\n❌ End-to-end FAILED. Body did not include paymentTx.");
      process.exitCode = 1;
    }
  } finally {
    httpServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
