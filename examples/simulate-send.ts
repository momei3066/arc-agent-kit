/**
 * Pre-flight a USDC transfer without spending. Useful for showing the user
 * "this will cost X USDC, will succeed" before they approve.
 *
 *   tsx examples/simulate-send.ts 0xFrom 0xTo 0.5
 *
 * No private key required — `from` is the address you'd send from.
 */

import "dotenv/config";
import type { Address } from "viem";
import { publicClient } from "../src/client.js";
import { formatSimulation, simulateSendUSDC } from "../src/simulate.js";

async function main() {
  const [from, to, amount] = [process.argv[2], process.argv[3], process.argv[4]];
  if (!from || !to || !amount || !from.startsWith("0x") || !to.startsWith("0x")) {
    console.error("Usage: tsx examples/simulate-send.ts 0xFrom 0xTo 0.5");
    process.exit(1);
  }

  const pub = publicClient(process.env.ARC_RPC_URL);
  const sim = await simulateSendUSDC(pub, from as Address, to as Address, amount);
  console.log(`Simulating: ${amount} USDC  ${from} → ${to}`);
  console.log(formatSimulation(sim));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
