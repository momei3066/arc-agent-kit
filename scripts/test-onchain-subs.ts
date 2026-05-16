/**
 * End-to-end smoke test against the deployed ArcSubscriptions contract.
 *
 *   tsx scripts/test-onchain-subs.ts
 *
 * Flow:
 *   1. Deposit 0.05 USDC into the contract's escrow
 *   2. Create a subscription: 0.01 USDC / 60s → 0xdeadbeef...
 *   3. Charge it once (should fire immediately)
 *   4. Read the subscription state back from chain
 *   5. Cancel the subscription
 *   6. Withdraw remaining escrow balance
 *
 * Every step prints a tx hash. The total damage is well under 0.1 USDC
 * plus a few cents of gas. Requires ARC_PRIVATE_KEY in .env.
 */

import "dotenv/config";
import type { Address, Hex } from "viem";
import { publicClient, walletClient } from "../src/client.js";
import {
  arcSubscriptionsAddress,
  cancelOnchainSubscription,
  chargeOnchainSubscription,
  createOnchainSubscription,
  depositEscrow,
  getCreatedSubscriptionId,
  getEscrowBalance,
  getOnchainSubscription,
  withdrawEscrow,
} from "../src/onchain-subs.js";

const RECIPIENT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Address;
const DEPOSIT_USDC = "0.05";
const CHARGE_AMOUNT_USDC = "0.01";
const INTERVAL_SECONDS = 60;

async function waitTx(pub: ReturnType<typeof publicClient>, hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return r;
}

async function main() {
  const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
  if (!pk) throw new Error("Missing ARC_PRIVATE_KEY");

  const wallet = walletClient(pk, process.env.ARC_RPC_URL);
  const pub = publicClient(process.env.ARC_RPC_URL);
  const me = wallet.account!.address;

  console.log(`signer:   ${me}`);
  console.log(`contract: ${arcSubscriptionsAddress()}`);
  console.log("");

  // 1. Deposit
  console.log(`[1/6] deposit ${DEPOSIT_USDC} USDC into escrow`);
  const dep = await depositEscrow(wallet, DEPOSIT_USDC);
  console.log(`      tx: ${dep.hash}`);
  await waitTx(pub, dep.hash);
  let bal = await getEscrowBalance(pub, me);
  console.log(`      escrow balance now: ${bal.formatted} USDC`);

  // 2. Create
  console.log("");
  console.log(`[2/6] create subscription ${CHARGE_AMOUNT_USDC} USDC / ${INTERVAL_SECONDS}s → ${RECIPIENT}`);
  const create = await createOnchainSubscription(
    wallet,
    RECIPIENT,
    CHARGE_AMOUNT_USDC,
    INTERVAL_SECONDS,
  );
  console.log(`      tx: ${create.hash}`);
  await waitTx(pub, create.hash);
  const id = await getCreatedSubscriptionId(pub, create.hash);
  if (id === null) throw new Error("couldn't extract subscription id from receipt");
  console.log(`      sub id: ${id}`);

  // 3. Read state
  console.log("");
  console.log("[3/6] read subscription state from chain");
  const sub = await getOnchainSubscription(pub, id);
  console.log(
    `      payer=${sub.payer.slice(0, 10)}… recipient=${sub.recipient.slice(0, 10)}… amount=${sub.amountUSDC} active=${sub.active} ticks=${sub.ticks}`,
  );

  // 4. Charge
  console.log("");
  console.log("[4/6] charge the subscription (should fire immediately)");
  const charge = await chargeOnchainSubscription(wallet, id);
  console.log(`      tx: ${charge.hash}`);
  await waitTx(pub, charge.hash);
  const subAfter = await getOnchainSubscription(pub, id);
  console.log(`      ticks now: ${subAfter.ticks}`);
  bal = await getEscrowBalance(pub, me);
  console.log(`      escrow balance after charge: ${bal.formatted} USDC`);

  // 5. Cancel
  console.log("");
  console.log("[5/6] cancel the subscription");
  const cancel = await cancelOnchainSubscription(wallet, id);
  console.log(`      tx: ${cancel.hash}`);
  await waitTx(pub, cancel.hash);
  const subFinal = await getOnchainSubscription(pub, id);
  console.log(`      active: ${subFinal.active}`);

  // 6. Withdraw remaining
  console.log("");
  console.log("[6/6] withdraw remaining escrow");
  bal = await getEscrowBalance(pub, me);
  if (bal.wei > 0n) {
    const w = await withdrawEscrow(wallet, bal.formatted);
    console.log(`      tx: ${w.hash}`);
    await waitTx(pub, w.hash);
  } else {
    console.log("      (nothing to withdraw)");
  }

  console.log("");
  console.log("✅ end-to-end on-chain subscription flow completed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
