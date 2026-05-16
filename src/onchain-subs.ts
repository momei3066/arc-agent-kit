/**
 * TypeScript wrapper for the deployed ArcSubscriptions contract.
 *
 * Reads the canonical deployment artifact (address + ABI) from
 * deployments/arc-testnet/ArcSubscriptions.json and exposes typed
 * read/write functions that compose nicely with the rest of arc-agent-kit.
 *
 * Pair with `src/recurring.ts` (the off-chain scheduler) and you get two
 * options for recurring USDC on Arc:
 *   - off-chain: cheaper, simpler, requires payer's agent to be online
 *   - on-chain (this module): trustless, decentralized cranking, costs gas
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ARC_NATIVE_DECIMALS, ARC_TESTNET_EXPLORER } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Find the deployments artifact by walking up from this file. Works both
 * when running via tsx (file is in src/) and from the compiled dist/.
 */
function resolveArtifactPath(): string {
  const candidates = [
    // process.cwd() when invoked from project root (npm scripts)
    resolve(process.cwd(), "deployments", "arc-testnet", "ArcSubscriptions.json"),
    // up one level from src/ (tsx run)
    resolve(__dirname, "..", "deployments", "arc-testnet", "ArcSubscriptions.json"),
    // up two levels from dist/src/ (compiled run)
    resolve(__dirname, "..", "..", "deployments", "arc-testnet", "ArcSubscriptions.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `ArcSubscriptions deployment artifact not found. Looked in:\n  ${candidates.join("\n  ")}\nRun \`npm run deploy:subscriptions\` first to create it.`,
  );
}

interface DeploymentArtifact {
  contractName: string;
  address: Address;
  deployTx: Hex;
  deployBlock: string;
  chainId: number;
  abi: readonly unknown[];
}

let cached: DeploymentArtifact | null = null;

export function loadArcSubscriptionsArtifact(): DeploymentArtifact {
  if (cached) return cached;
  const raw = readFileSync(resolveArtifactPath(), "utf8");
  cached = JSON.parse(raw) as DeploymentArtifact;
  return cached;
}

export function arcSubscriptionsAddress(): Address {
  return loadArcSubscriptionsArtifact().address;
}

export function arcSubscriptionsAbi(): readonly unknown[] {
  return loadArcSubscriptionsArtifact().abi;
}

/* -------------------- read methods -------------------- */

export interface OnchainSubscription {
  payer: Address;
  recipient: Address;
  amountWei: bigint;
  amountUSDC: string;
  intervalSeconds: bigint;
  lastChargedAt: bigint;
  ticks: bigint;
  active: boolean;
}

export async function getOnchainSubscription(
  pub: PublicClient,
  id: bigint,
): Promise<OnchainSubscription> {
  const result = (await pub.readContract({
    address: arcSubscriptionsAddress(),
    abi: arcSubscriptionsAbi(),
    functionName: "subscriptions",
    args: [id],
  })) as readonly [Address, Address, bigint, bigint, bigint, bigint, boolean];
  return {
    payer: result[0],
    recipient: result[1],
    amountWei: result[2],
    amountUSDC: formatUnits(result[2], ARC_NATIVE_DECIMALS),
    intervalSeconds: result[3],
    lastChargedAt: result[4],
    ticks: result[5],
    active: result[6],
  };
}

export async function getEscrowBalance(
  pub: PublicClient,
  payer: Address,
): Promise<{ wei: bigint; formatted: string }> {
  const wei = (await pub.readContract({
    address: arcSubscriptionsAddress(),
    abi: arcSubscriptionsAbi(),
    functionName: "balances",
    args: [payer],
  })) as bigint;
  return { wei, formatted: formatUnits(wei, ARC_NATIVE_DECIMALS) };
}

export async function isSubscriptionDue(
  pub: PublicClient,
  id: bigint,
): Promise<boolean> {
  return (await pub.readContract({
    address: arcSubscriptionsAddress(),
    abi: arcSubscriptionsAbi(),
    functionName: "isDue",
    args: [id],
  })) as boolean;
}

/* -------------------- write methods -------------------- */

export interface TxResultWithLink {
  hash: Hex;
  explorerUrl: string;
}

function explorer(hash: Hex): string {
  return `${ARC_TESTNET_EXPLORER}/tx/${hash}`;
}

/** Deposit native USDC into your escrow balance on the contract. */
export async function depositEscrow(
  wallet: WalletClient,
  amountUSDC: string,
): Promise<TxResultWithLink> {
  if (!wallet.account) throw new Error("wallet has no account");
  const hash = await wallet.sendTransaction({
    account: wallet.account,
    chain: wallet.chain,
    to: arcSubscriptionsAddress(),
    value: parseUnits(amountUSDC, ARC_NATIVE_DECIMALS),
  });
  return { hash, explorerUrl: explorer(hash) };
}

export async function withdrawEscrow(
  wallet: WalletClient,
  amountUSDC: string,
): Promise<TxResultWithLink> {
  if (!wallet.account) throw new Error("wallet has no account");
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address: arcSubscriptionsAddress(),
    abi: arcSubscriptionsAbi(),
    functionName: "withdraw",
    args: [parseUnits(amountUSDC, ARC_NATIVE_DECIMALS)],
  });
  return { hash, explorerUrl: explorer(hash) };
}

export async function createOnchainSubscription(
  wallet: WalletClient,
  recipient: Address,
  amountUSDC: string,
  intervalSeconds: number,
): Promise<TxResultWithLink> {
  if (!wallet.account) throw new Error("wallet has no account");
  if (intervalSeconds < 60) {
    throw new Error("intervalSeconds must be >= 60 (contract enforces this too)");
  }
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address: arcSubscriptionsAddress(),
    abi: arcSubscriptionsAbi(),
    functionName: "createSubscription",
    args: [recipient, parseUnits(amountUSDC, ARC_NATIVE_DECIMALS), BigInt(intervalSeconds)],
  });
  return { hash, explorerUrl: explorer(hash) };
}

export async function chargeOnchainSubscription(
  wallet: WalletClient,
  id: bigint,
): Promise<TxResultWithLink> {
  if (!wallet.account) throw new Error("wallet has no account");
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address: arcSubscriptionsAddress(),
    abi: arcSubscriptionsAbi(),
    functionName: "charge",
    args: [id],
  });
  return { hash, explorerUrl: explorer(hash) };
}

export async function cancelOnchainSubscription(
  wallet: WalletClient,
  id: bigint,
): Promise<TxResultWithLink> {
  if (!wallet.account) throw new Error("wallet has no account");
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address: arcSubscriptionsAddress(),
    abi: arcSubscriptionsAbi(),
    functionName: "cancel",
    args: [id],
  });
  return { hash, explorerUrl: explorer(hash) };
}

/** Extract the new subscription id from a createSubscription tx receipt. */
export async function getCreatedSubscriptionId(
  pub: PublicClient,
  txHash: Hex,
): Promise<bigint | null> {
  const receipt = await pub.getTransactionReceipt({ hash: txHash });
  // Event: SubscriptionCreated(uint256 indexed id, address indexed payer, address indexed recipient, uint256 amountWei, uint256 intervalSeconds)
  // topic[0] = event sig hash, topic[1] = id (indexed uint256)
  // We don't have the canonical topic0 hardcoded; just look at the first
  // log from our contract and read topic[1] as the id. The deploy contract
  // currently only emits one log per charge/create — this is robust enough
  // for our needs and avoids ethers-style decode plumbing.
  const target = arcSubscriptionsAddress().toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== target) continue;
    if (log.topics.length >= 2 && log.topics[1]) {
      return BigInt(log.topics[1]);
    }
  }
  return null;
}
