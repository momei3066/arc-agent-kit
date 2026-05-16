/**
 * Demo: pay for an HTTP API call via x402, from an Arc testnet wallet.
 *
 *   npm run example:x402 -- https://some-paywalled-api.example.com/endpoint
 *
 * Requires ARC_PRIVATE_KEY in .env. The wallet must be funded with USDC on
 * Arc testnet (the gas asset). When the target server responds with 402
 * Payment Required, this script's wrapped fetch will sign an EIP-712
 * payment authorization and retry the request automatically — you'll see
 * the final response printed to stdout.
 *
 * If you don't have a real x402-paywalled URL to test against, you can
 * still verify the wallet wiring works by passing any URL — anything that
 * doesn't reply with 402 will just pass through normally.
 */

import "dotenv/config";
import type { Hex } from "viem";
import { createArcPaidFetch, X402_ARC_NETWORK } from "../src/x402.js";

async function main() {
  const url = process.argv[2];
  if (!url || !url.startsWith("http")) {
    console.error("Usage: tsx examples/x402-pay.ts <url>");
    console.error(
      "Example: tsx examples/x402-pay.ts https://api.example.com/paid-endpoint",
    );
    process.exit(1);
  }

  const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    console.error("Missing ARC_PRIVATE_KEY in .env");
    process.exit(1);
  }

  console.log(`x402 network: ${X402_ARC_NETWORK}`);
  console.log(`Fetching:     ${url}`);

  const paidFetch = createArcPaidFetch(pk, process.env.ARC_RPC_URL);
  const response = await paidFetch(url);
  console.log(`Status:       ${response.status} ${response.statusText}`);

  const ct = response.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? JSON.stringify(await response.json(), null, 2)
    : await response.text();
  console.log("--- response body ---");
  console.log(body.slice(0, 4000));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
