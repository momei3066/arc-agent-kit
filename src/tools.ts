/**
 * Core operations an agent (or a human) can call on Arc testnet.
 *
 * All amounts are human-readable strings (e.g. "1.5") to avoid bigint-juggling
 * at the call site. Internally we use viem's parseUnits / formatUnits.
 */

import {
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient,
  type PublicClient,
  erc20Abi,
} from "viem";
import {
  ARC_NATIVE_DECIMALS,
  ARC_TESTNET_EXPLORER,
  EURC_ADDRESS,
  EURC_DECIMALS,
  USDC_ADDRESS,
} from "./constants.js";

export interface TxResult {
  hash: Hex;
  explorerUrl: string;
}

export interface TxStatus {
  hash: Hex;
  status: "success" | "reverted" | "pending";
  blockNumber: bigint | null;
  gasUsed: bigint | null;
  explorerUrl: string;
}

/** Native USDC balance (Arc's gas token) for a given address. */
export async function getUSDCBalance(
  pub: PublicClient,
  address: Address,
): Promise<string> {
  const wei = await pub.getBalance({ address });
  return formatUnits(wei, ARC_NATIVE_DECIMALS);
}

/** EURC balance (ERC-20) for a given address. */
export async function getEURCBalance(
  pub: PublicClient,
  address: Address,
): Promise<string> {
  const raw = await pub.readContract({
    address: EURC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return formatUnits(raw, EURC_DECIMALS);
}

/** Generic ERC-20 balance, for any token deployed on Arc. */
export async function getERC20Balance(
  pub: PublicClient,
  token: Address,
  holder: Address,
): Promise<{ raw: bigint; formatted: string; decimals: number }> {
  const [raw, decimals] = await Promise.all([
    pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    }),
    pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);
  return { raw, decimals, formatted: formatUnits(raw, decimals) };
}

/**
 * Send native USDC to `to`. Amount is a decimal string ("1.5" = 1.5 USDC).
 * On Arc this is a normal native-token transfer — USDC IS the gas token.
 */
export async function sendUSDC(
  wallet: WalletClient,
  to: Address,
  amount: string,
): Promise<TxResult> {
  if (!wallet.account) {
    throw new Error("walletClient is missing an account — pass a private key.");
  }
  const value = parseUnits(amount, ARC_NATIVE_DECIMALS);
  const hash = await wallet.sendTransaction({
    account: wallet.account,
    chain: wallet.chain,
    to,
    value,
  });
  return { hash, explorerUrl: explorerLink(hash) };
}

/** Send EURC (ERC-20) to `to`. */
export async function sendEURC(
  wallet: WalletClient,
  to: Address,
  amount: string,
): Promise<TxResult> {
  if (!wallet.account) {
    throw new Error("walletClient is missing an account — pass a private key.");
  }
  const value = parseUnits(amount, EURC_DECIMALS);
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: wallet.chain,
    address: EURC_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, value],
  });
  return { hash, explorerUrl: explorerLink(hash) };
}

/** Look up a transaction's receipt; returns "pending" if not yet mined. */
export async function getTransactionStatus(
  pub: PublicClient,
  hash: Hex,
): Promise<TxStatus> {
  try {
    const receipt = await pub.getTransactionReceipt({ hash });
    return {
      hash,
      status: receipt.status === "success" ? "success" : "reverted",
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      explorerUrl: explorerLink(hash),
    };
  } catch {
    return {
      hash,
      status: "pending",
      blockNumber: null,
      gasUsed: null,
      explorerUrl: explorerLink(hash),
    };
  }
}

/** Block until a transaction is mined (or `timeout` ms elapses). */
export async function waitForTx(
  pub: PublicClient,
  hash: Hex,
  timeout = 60_000,
): Promise<TxStatus> {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout });
  return {
    hash,
    status: receipt.status === "success" ? "success" : "reverted",
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    explorerUrl: explorerLink(hash),
  };
}

export function explorerLink(hash: Hex): string {
  return `${ARC_TESTNET_EXPLORER}/tx/${hash}`;
}

export function addressLink(address: Address): string {
  return `${ARC_TESTNET_EXPLORER}/address/${address}`;
}
