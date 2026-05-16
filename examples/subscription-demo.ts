/**
 * End-to-end demo of the recurring payment scheduler.
 *
 *   npm run example:subs -- 0xRecipient 0.005 60
 *
 * Creates one subscription, runs the scheduler for ~3 minutes (so it fires
 * twice if the interval is 60s), then cancels and reports. Requires
 * ARC_PRIVATE_KEY in .env and the wallet must be funded with USDC.
 *
 * Use this to verify the loop end-to-end before turning the agent loose
 * with longer-running subscriptions.
 */

import "dotenv/config";
import type { Address, Hex } from "viem";
import { publicClient, walletClient } from "../src/client.js";
import {
  DEFAULT_STORE_PATH,
  createSubscription,
  loadStore,
  parseDuration,
  saveStore,
  setStatus,
  tickOnce,
} from "../src/recurring.js";
import { addressLink } from "../src/tools.js";

const RUN_FOR_SECONDS = 200;

async function main() {
  const [to, amount, intervalArg] = [
    process.argv[2],
    process.argv[3],
    process.argv[4] ?? "60",
  ];
  if (!to || !amount || !to.startsWith("0x") || to.length !== 42) {
    console.error(
      "Usage: tsx examples/subscription-demo.ts 0xRecipient 0.005 [interval]\n" +
        "  interval default 60 (seconds). Accepts '60', '60s', '5m', '1h', '1d'.",
    );
    process.exit(1);
  }
  const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    console.error("Missing ARC_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const wallet = walletClient(pk, process.env.ARC_RPC_URL);
  const pub = publicClient(process.env.ARC_RPC_URL);

  const from = wallet.account!.address;
  console.log(`Signer:    ${from}`);
  console.log(`           ${addressLink(from)}`);

  const intervalSeconds = parseDuration(intervalArg);
  const store = loadStore(DEFAULT_STORE_PATH);
  const sub = createSubscription(store, {
    to: to as Address,
    amount,
    intervalSeconds,
    label: "subscription-demo",
  });
  saveStore(store, DEFAULT_STORE_PATH);
  console.log(`Created:   sub ${sub.id} — ${amount} USDC every ${intervalSeconds}s → ${to}`);

  const deadline = Date.now() + RUN_FOR_SECONDS * 1000;
  let totalFired = 0;
  while (Date.now() < deadline) {
    const fresh = loadStore(DEFAULT_STORE_PATH);
    const results = await tickOnce(fresh, wallet, pub, DEFAULT_STORE_PATH);
    for (const r of results.filter((x) => x.outcome === "ran")) {
      totalFired++;
      console.log(`✅ fired — ${r.txHash}  (${r.explorerUrl})`);
    }
    if (totalFired >= 2) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // Always clean up so the demo doesn't leave a live sub behind.
  const finalStore = loadStore(DEFAULT_STORE_PATH);
  setStatus(finalStore, sub.id, "cancelled");
  saveStore(finalStore, DEFAULT_STORE_PATH);
  console.log(`Cleanup:   sub ${sub.id} cancelled`);

  if (totalFired === 0) {
    console.error("⚠️  Nothing fired — check balance / RPC connectivity.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
