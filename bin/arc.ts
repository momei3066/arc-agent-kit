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
  createSubscription,
  loadStore,
  saveStore,
  setStatus,
  tickOnce,
  runForever,
  previewNextWindow,
  parseDuration,
  DEFAULT_STORE_PATH,
} from "../src/recurring.js";
import {
  arcSubscriptionsAddress,
  cancelOnchainSubscription,
  chargeOnchainSubscription,
  createOnchainSubscription,
  depositEscrow,
  getCreatedSubscriptionId,
  getEscrowBalance,
  getOnchainSubscription,
  isSubscriptionDue,
  withdrawEscrow,
} from "../src/onchain-subs.js";
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

  Subscriptions (off-chain recurring USDC payments):
  subs add <to> <amount> <interval> [label]   Schedule (e.g. interval "1h", "1d").
  subs list                                    List all subscriptions.
  subs pause <id> / subs resume <id>           Toggle a subscription.
  subs cancel <id>                             Cancel + remove.
  subs tick                                    Run one scheduler pass (cron-friendly).
  subs run                                     Run scheduler in foreground (Ctrl-C to stop).
  subs preview                                  Will the wallet cover the next charge cycle?

  On-chain (trustless via the deployed ArcSubscriptions contract):
  onchain address                              Print the deployed contract address.
  onchain balance [payer]                      Read escrow balance (defaults to signer).
  onchain deposit <amount>                     Deposit native USDC into your escrow.
  onchain withdraw <amount>                    Withdraw unspent escrow.
  onchain create <to> <amount> <interval>      Create a new subscription on-chain.
  onchain charge <id>                          Crank: fire the charge if due.
  onchain cancel <id>                          Cancel a subscription you own.
  onchain status <id>                          Read a subscription's current state.
  onchain due <id>                             Boolean: would charge() succeed right now?

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

    case "subs": {
      // argv: [node, script, "subs", sub, arg1, arg2, ...rest]
      //       [   0,      1,      2,   3,    4,    5,  6+ ]
      await runSubsCommand(pub, a, b, c, process.argv.slice(6));
      return;
    }

    case "onchain": {
      await runOnchainCommand(pub, a, b, c, process.argv.slice(6));
      return;
    }

    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

/* -------------------- subs subcommand -------------------- */

async function runSubsCommand(
  pub: ReturnType<typeof publicClient>,
  sub?: string,
  arg1?: string,
  arg2?: string,
  rest: string[] = [],
): Promise<void> {
  const storePath = DEFAULT_STORE_PATH;
  switch (sub) {
    case "list": {
      const store = loadStore(storePath);
      if (store.subscriptions.length === 0) {
        console.log("No subscriptions. Add one with `arc subs add ...`");
        return;
      }
      for (const s of store.subscriptions) {
        const nextIn = Math.max(0, Math.round((s.nextRunAt - Date.now()) / 1000));
        console.log(
          `[${s.id}] ${s.status.padEnd(9)} ${s.amount} USDC → ${s.to}  every ${s.intervalSeconds}s` +
            (s.label ? `  (${s.label})` : "") +
            `\n          ticks=${s.ticks}${s.maxTicks ? `/${s.maxTicks}` : ""}  nextIn=${nextIn}s  ` +
            (s.lastTxHash ? `lastTx=${s.lastTxHash.slice(0, 12)}…` : "lastTx=(none)"),
        );
      }
      return;
    }

    case "add": {
      if (!isAddress(arg1) || !arg2 || !rest[0]) {
        return fail(
          "subs add: need <to> <amount> <interval> [label]\n" +
            "  example: arc subs add 0xabc 0.01 1h my-rent-stream",
        );
      }
      const intervalSeconds = parseDuration(rest[0]!);
      const label = rest.slice(1).join(" ") || undefined;
      const store = loadStore(storePath);
      const created = createSubscription(store, {
        to: arg1,
        amount: arg2,
        intervalSeconds,
        label,
      });
      saveStore(store, storePath);
      console.log(`Added subscription [${created.id}]`);
      console.log(`  ${created.amount} USDC → ${created.to}`);
      console.log(`  every ${created.intervalSeconds}s (≈${(created.intervalSeconds / 3600).toFixed(2)}h)`);
      console.log(`  first run: now`);
      return;
    }

    case "pause":
    case "resume":
    case "cancel": {
      if (!arg1) return fail(`subs ${sub}: need <id>`);
      const store = loadStore(storePath);
      const status: "active" | "paused" | "cancelled" =
        sub === "pause" ? "paused" : sub === "resume" ? "active" : "cancelled";
      setStatus(store, arg1, status);
      saveStore(store, storePath);
      console.log(`subscription ${arg1} → ${status}`);
      return;
    }

    case "tick": {
      const wallet = getWallet();
      const store = loadStore(storePath);
      const results = await tickOnce(store, wallet, pub, storePath);
      console.log(JSON.stringify(results, bigintSerializer, 2));
      return;
    }

    case "run": {
      const wallet = getWallet();
      const interval = arg1 ? parseDuration(arg1) : 60;
      console.log(`Scheduler running. Tick every ${interval}s. Ctrl-C to stop.`);
      await runForever(storePath, wallet, pub, interval, (results) => {
        const acted = results.filter((r) => r.outcome === "ran" || r.outcome === "failed");
        if (acted.length === 0) return;
        for (const r of acted) {
          if (r.outcome === "ran") {
            console.log(`✅ [${r.subscriptionId}] paid — ${r.txHash}`);
          } else {
            console.log(`❌ [${r.subscriptionId}] ${r.outcome}: ${r.reason ?? ""}`);
          }
        }
      });
      return;
    }

    case "preview": {
      const wallet = getWallet();
      const store = loadStore(storePath);
      const from = wallet.account!.address;
      const preview = await previewNextWindow(store, pub, from);
      console.log(JSON.stringify(preview, null, 2));
      return;
    }

    default:
      fail(
        `subs: unknown subcommand "${sub ?? ""}".\n` +
          "Try: list | add | pause | resume | cancel | tick | run | preview",
      );
  }
}

function bigintSerializer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/* -------------------- onchain subcommand -------------------- */

async function runOnchainCommand(
  pub: ReturnType<typeof publicClient>,
  sub?: string,
  arg1?: string,
  arg2?: string,
  rest: string[] = [],
): Promise<void> {
  switch (sub) {
    case "address": {
      console.log(arcSubscriptionsAddress());
      return;
    }

    case "balance": {
      let who: Address;
      if (arg1) {
        if (!isAddress(arg1)) return fail("onchain balance: address must be 0x-prefixed 40-char hex");
        who = arg1;
      } else {
        who = getWallet().account!.address;
      }
      const { formatted } = await getEscrowBalance(pub, who);
      console.log(`Escrow for ${who}: ${formatted} USDC`);
      return;
    }

    case "deposit": {
      if (!arg1) return fail("onchain deposit: need <amount>");
      const wallet = getWallet();
      console.log(`Depositing ${arg1} USDC into escrow...`);
      const res = await depositEscrow(wallet, arg1);
      console.log(`Tx: ${res.hash}\n    ${res.explorerUrl}`);
      await pub.waitForTransactionReceipt({ hash: res.hash });
      const after = await getEscrowBalance(pub, wallet.account!.address);
      console.log(`Balance now: ${after.formatted} USDC`);
      return;
    }

    case "withdraw": {
      if (!arg1) return fail("onchain withdraw: need <amount>");
      const wallet = getWallet();
      console.log(`Withdrawing ${arg1} USDC from escrow...`);
      const res = await withdrawEscrow(wallet, arg1);
      console.log(`Tx: ${res.hash}\n    ${res.explorerUrl}`);
      await pub.waitForTransactionReceipt({ hash: res.hash });
      const after = await getEscrowBalance(pub, wallet.account!.address);
      console.log(`Balance now: ${after.formatted} USDC`);
      return;
    }

    case "create": {
      if (!isAddress(arg1) || !arg2 || !rest[0]) {
        return fail("onchain create: need <to> <amount> <interval>\n  e.g. arc onchain create 0xabc 0.01 1h");
      }
      const intervalSeconds = parseDuration(rest[0]!);
      const wallet = getWallet();
      console.log(`Creating ${arg2} USDC / ${intervalSeconds}s subscription → ${arg1}...`);
      const res = await createOnchainSubscription(wallet, arg1, arg2, intervalSeconds);
      console.log(`Tx: ${res.hash}\n    ${res.explorerUrl}`);
      await pub.waitForTransactionReceipt({ hash: res.hash });
      const id = await getCreatedSubscriptionId(pub, res.hash);
      console.log(`New subscription id: ${id ?? "(could not parse from receipt)"}`);
      return;
    }

    case "charge": {
      if (!arg1) return fail("onchain charge: need <id>");
      const id = BigInt(arg1);
      const wallet = getWallet();
      const res = await chargeOnchainSubscription(wallet, id);
      console.log(`Tx: ${res.hash}\n    ${res.explorerUrl}`);
      await pub.waitForTransactionReceipt({ hash: res.hash });
      const after = await getOnchainSubscription(pub, id);
      console.log(`ticks now: ${after.ticks}`);
      return;
    }

    case "cancel": {
      if (!arg1) return fail("onchain cancel: need <id>");
      const id = BigInt(arg1);
      const wallet = getWallet();
      const res = await cancelOnchainSubscription(wallet, id);
      console.log(`Tx: ${res.hash}\n    ${res.explorerUrl}`);
      await pub.waitForTransactionReceipt({ hash: res.hash });
      console.log("Cancelled.");
      return;
    }

    case "status": {
      if (!arg1) return fail("onchain status: need <id>");
      const id = BigInt(arg1);
      const s = await getOnchainSubscription(pub, id);
      console.log(
        JSON.stringify(
          {
            id: arg1,
            payer: s.payer,
            recipient: s.recipient,
            amountUSDC: s.amountUSDC,
            intervalSeconds: s.intervalSeconds.toString(),
            lastChargedAt: s.lastChargedAt.toString(),
            ticks: s.ticks.toString(),
            active: s.active,
          },
          null,
          2,
        ),
      );
      return;
    }

    case "due": {
      if (!arg1) return fail("onchain due: need <id>");
      const due = await isSubscriptionDue(pub, BigInt(arg1));
      console.log(due ? "yes" : "no");
      return;
    }

    default:
      fail(
        `onchain: unknown subcommand "${sub ?? ""}".\n` +
          "Try: address | balance | deposit | withdraw | create | charge | cancel | status | due",
      );
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
