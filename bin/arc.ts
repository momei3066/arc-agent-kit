#!/usr/bin/env node
/**
 * arc — CLI for Arc Network testnet.
 *
 *   arc info
 *   arc balance <address>
 *   arc send-usdc <to> <amount>
 *   arc send-eurc <to> <amount>
 *   arc simulate-usdc <to> <amount>
 *   arc tx <hash>
 *   arc cctp
 *
 * Reads ARC_PRIVATE_KEY and ARC_RPC_URL from .env (or process.env).
 * Read commands work without a key. Write commands require one.
 */

import "dotenv/config";
import type { Address, Hex } from "viem";
import { publicClient, walletClient } from "../src/client.js";
import {
  addressLink,
  explorerLink,
  getEURCBalance,
  getTransactionStatus,
  getUSDCBalance,
  sendEURC,
  sendUSDC,
  waitForTx,
} from "../src/tools.js";
import {
  formatSimulation,
  simulateSendEURC,
  simulateSendUSDC,
} from "../src/simulate.js";
import { getArcDomain, getCctpContracts } from "../src/cctp.js";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER,
  ARC_TESTNET_RPC,
  FAUCET_URL,
} from "../src/constants.js";

const HELP = `arc — Arc Network testnet CLI

Commands:
  info                              Print chain config and signer (if any).
  balance <address>                 USDC + EURC balance.
  send-usdc <to> <amount>           Send native USDC. Requires ARC_PRIVATE_KEY.
  send-eurc <to> <amount>           Send EURC (ERC-20). Requires ARC_PRIVATE_KEY.
  simulate-usdc <to> <amount>       Dry-run a USDC send. No key needed.
  simulate-eurc <to> <amount>       Dry-run an EURC send. No key needed.
  tx <hash>                         Check a transaction's status.
  cctp                              Show CCTP V2 contracts + Arc's domain ID.
  help                              Show this help.

Environment (loaded from .env):
  ARC_PRIVATE_KEY    0x-prefixed 32-byte key (only for send-*).
  ARC_RPC_URL        Override the default RPC endpoint.
`;

function isAddress(x: string | undefined): x is Address {
  return !!x && /^0x[a-fA-F0-9]{40}$/.test(x);
}
function isHash(x: string | undefined): x is Hex {
  return !!x && /^0x[a-fA-F0-9]{64}$/.test(x);
}

function getWallet() {
  const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    console.error("Missing ARC_PRIVATE_KEY in environment / .env.");
    process.exit(1);
  }
  return walletClient(pk, process.env.ARC_RPC_URL);
}

/**
 * Parse simulate-* args, supporting both `<to> <amount>` (sender = signer) and
 * `<from> <to> <amount>` (explicit sender, no key required).
 */
function resolveSimArgs(
  a?: string,
  b?: string,
  c?: string,
): { from?: Address; to?: Address; amount?: string } {
  if (isAddress(a) && isAddress(b) && c) {
    return { from: a, to: b, amount: c };
  }
  if (isAddress(a) && b && !c) {
    const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
    if (!pk) return {};
    const from = walletClient(pk).account!.address;
    return { from, to: a, amount: b };
  }
  return {};
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const pub = publicClient(process.env.ARC_RPC_URL);

  switch (cmd) {
    case "info": {
      const signer = (() => {
        try {
          const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
          return pk ? walletClient(pk).account?.address : null;
        } catch {
          return null;
        }
      })();
      console.log(
        JSON.stringify(
          {
            chainId: ARC_TESTNET_CHAIN_ID,
            rpc: process.env.ARC_RPC_URL ?? ARC_TESTNET_RPC,
            explorer: ARC_TESTNET_EXPLORER,
            faucet: FAUCET_URL,
            signer,
          },
          null,
          2,
        ),
      );
      return;
    }

    case "balance": {
      if (!isAddress(a)) return fail("balance: need a valid address");
      const [usdc, eurc] = await Promise.all([
        getUSDCBalance(pub, a),
        getEURCBalance(pub, a),
      ]);
      console.log(`Address: ${a}`);
      console.log(`         ${addressLink(a)}`);
      console.log(`USDC:    ${usdc}`);
      console.log(`EURC:    ${eurc}`);
      return;
    }

    case "send-usdc": {
      if (!isAddress(a) || !b) return fail("send-usdc: need <to> <amount>");
      const wallet = getWallet();
      console.log(`From:    ${wallet.account!.address}`);
      console.log(`Sending: ${b} USDC → ${a}`);
      const { hash, explorerUrl } = await sendUSDC(wallet, a, b);
      console.log(`Tx:      ${hash}`);
      console.log(`         ${explorerUrl}`);
      console.log("Confirming...");
      const status = await waitForTx(pub, hash);
      console.log(`Status:  ${status.status} in block ${status.blockNumber}`);
      return;
    }

    case "send-eurc": {
      if (!isAddress(a) || !b) return fail("send-eurc: need <to> <amount>");
      const wallet = getWallet();
      console.log(`From:    ${wallet.account!.address}`);
      console.log(`Sending: ${b} EURC → ${a}`);
      const { hash, explorerUrl } = await sendEURC(wallet, a, b);
      console.log(`Tx:      ${hash}`);
      console.log(`         ${explorerUrl}`);
      console.log("Confirming...");
      const status = await waitForTx(pub, hash);
      console.log(`Status:  ${status.status} in block ${status.blockNumber}`);
      return;
    }

    case "simulate-usdc": {
      // Two arg forms:
      //   simulate-usdc <to> <amount>          — from = signer (requires key)
      //   simulate-usdc <from> <to> <amount>   — explicit from, no key needed
      const { from, to, amount } = resolveSimArgs(a, b, c);
      if (!from || !to || !amount) {
        return fail(
          "simulate-usdc: need <to> <amount> (with ARC_PRIVATE_KEY) or <from> <to> <amount>",
        );
      }
      const sim = await simulateSendUSDC(pub, from, to, amount);
      console.log(formatSimulation(sim));
      return;
    }

    case "simulate-eurc": {
      const { from, to, amount } = resolveSimArgs(a, b, c);
      if (!from || !to || !amount) {
        return fail(
          "simulate-eurc: need <to> <amount> (with ARC_PRIVATE_KEY) or <from> <to> <amount>",
        );
      }
      const sim = await simulateSendEURC(pub, from, to, amount);
      console.log(formatSimulation(sim));
      return;
    }

    case "tx": {
      if (!isHash(a)) return fail("tx: need a 0x-prefixed 64-char hash");
      const status = await getTransactionStatus(pub, a);
      console.log(
        JSON.stringify(
          {
            ...status,
            blockNumber: status.blockNumber?.toString() ?? null,
            gasUsed: status.gasUsed?.toString() ?? null,
          },
          null,
          2,
        ),
      );
      console.log(explorerLink(a));
      return;
    }

    case "cctp": {
      const [domain, contracts] = await Promise.all([
        getArcDomain(pub),
        Promise.resolve(getCctpContracts()),
      ]);
      console.log(JSON.stringify({ arcDomain: domain, contracts }, null, 2));
      return;
    }

    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
