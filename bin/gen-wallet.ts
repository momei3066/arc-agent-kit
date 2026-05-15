#!/usr/bin/env node
/**
 * Generate a fresh testnet wallet and write the private key to .env.
 *
 *   tsx bin/gen-wallet.ts           # safe default — refuses if .env has ARC_PRIVATE_KEY
 *   tsx bin/gen-wallet.ts --force   # overwrite the existing key
 *
 * The private key is NEVER printed to stdout/stderr — only the address.
 * The .env file is created with 0600 perms (owner read/write only).
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_EXPLORER, FAUCET_URL } from "../src/constants.js";

const ENV_PATH = resolve(process.cwd(), ".env");
const force = process.argv.includes("--force");

function main() {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";

  if (/^ARC_PRIVATE_KEY=0x[a-fA-F0-9]/m.test(existing) && !force) {
    console.error(
      `.env already contains ARC_PRIVATE_KEY. Refusing to overwrite.\n` +
        `Pass --force to overwrite (your old key will be lost forever — back it up first if it has funds).`,
    );
    process.exit(1);
  }

  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);

  // Replace any existing ARC_PRIVATE_KEY line, or append a new one.
  let updated: string;
  if (/^ARC_PRIVATE_KEY=.*$/m.test(existing)) {
    updated = existing.replace(/^ARC_PRIVATE_KEY=.*$/m, `ARC_PRIVATE_KEY=${pk}`);
  } else {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    updated = `${existing}${sep}ARC_PRIVATE_KEY=${pk}\n`;
  }

  writeFileSync(ENV_PATH, updated, { mode: 0o600 });
  try {
    chmodSync(ENV_PATH, 0o600);
  } catch {
    // best-effort
  }

  // Print address only. NEVER print pk.
  console.log("New Arc testnet wallet generated.");
  console.log("");
  console.log(`Address:  ${account.address}`);
  console.log(`Explorer: ${ARC_TESTNET_EXPLORER}/address/${account.address}`);
  console.log("");
  console.log("Private key was written to .env (mode 0600). Don't commit it.");
  console.log(`Fund it with testnet USDC: ${FAUCET_URL}`);
}

main();
