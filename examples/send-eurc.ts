/**
 * Send EURC (ERC-20) on Arc testnet.
 *
 *   npm run example:send-eurc -- 0xRecipient 1.5
 *
 * Requires ARC_PRIVATE_KEY in .env, and the wallet needs both:
 *   - some USDC for gas (Arc's gas token)
 *   - the EURC balance you want to transfer
 */

import "dotenv/config";
import type { Address, Hex } from "viem";
import { publicClient, walletClient } from "../src/client.js";
import { getEURCBalance, sendEURC, waitForTx } from "../src/tools.js";

async function main() {
  const [to, amount] = [process.argv[2], process.argv[3]];
  if (!to || !amount || !to.startsWith("0x") || to.length !== 42) {
    console.error("Usage: tsx examples/send-eurc.ts 0xRecipient 1.5");
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

  const beforeBalance = await getEURCBalance(pub, from);
  console.log(`From:    ${from}`);
  console.log(`Balance: ${beforeBalance} EURC`);
  console.log(`Sending: ${amount} EURC → ${to}`);

  const { hash, explorerUrl } = await sendEURC(wallet, to as Address, amount);
  console.log(`Tx:      ${hash}`);
  console.log(`         ${explorerUrl}`);

  console.log("Waiting for confirmation...");
  const status = await waitForTx(pub, hash);
  console.log(`Status:  ${status.status} in block ${status.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
