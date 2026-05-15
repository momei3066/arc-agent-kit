/**
 * Read-only example. No private key required.
 *
 *   npm run example:balance -- 0xYourAddress
 *
 * If no address is passed, prints help.
 */

import "dotenv/config";
import { publicClient } from "../src/client.js";
import { getEURCBalance, getUSDCBalance, addressLink } from "../src/tools.js";
import { FAUCET_URL } from "../src/constants.js";
import type { Address } from "viem";

async function main() {
  const address = process.argv[2] as Address | undefined;
  if (!address || !address.startsWith("0x") || address.length !== 42) {
    console.error(
      "Usage: tsx examples/check-balance.ts 0xYourAddress\n" +
        "Get a testnet wallet funded at " +
        FAUCET_URL,
    );
    process.exit(1);
  }

  const pub = publicClient(process.env.ARC_RPC_URL);
  const [usdc, eurc] = await Promise.all([
    getUSDCBalance(pub, address),
    getEURCBalance(pub, address),
  ]);

  console.log(`Address:  ${address}`);
  console.log(`Explorer: ${addressLink(address)}`);
  console.log(`USDC:     ${usdc}  (native gas token)`);
  console.log(`EURC:     ${eurc}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
