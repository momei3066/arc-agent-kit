/**
 * Send native USDC on Arc testnet.
 *
 *   npm run example:send-usdc -- 0xRecipient 0.01
 *
 * Requires ARC_PRIVATE_KEY in .env. The signing wallet must be funded
 * via https://faucet.circle.com .
 */

import "dotenv/config";
import type { Address, Hex } from "viem";
import { publicClient, walletClient } from "../src/client.js";
import { sendUSDC, waitForTx, getUSDCBalance } from "../src/tools.js";

async function main() {
  const [to, amount] = [process.argv[2], process.argv[3]];
  if (!to || !amount || !to.startsWith("0x") || to.length !== 42) {
    console.error("Usage: tsx examples/send-usdc.ts 0xRecipient 0.01");
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

  const beforeBalance = await getUSDCBalance(pub, from);
  console.log(`From:    ${from}`);
  console.log(`Balance: ${beforeBalance} USDC`);
  console.log(`Sending: ${amount} USDC → ${to}`);

  const { hash, explorerUrl } = await sendUSDC(wallet, to as Address, amount);
  console.log(`Tx:      ${hash}`);
  console.log(`         ${explorerUrl}`);

  console.log("Waiting for confirmation...");
  const status = await waitForTx(pub, hash);
  console.log(`Status:  ${status.status} in block ${status.blockNumber}`);

  const afterBalance = await getUSDCBalance(pub, from);
  console.log(`Balance: ${afterBalance} USDC`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
