/**
 * Read-only and signing clients for Arc testnet.
 *
 * `publicClient()` works without any key — for balance / status queries.
 * `walletClient()` requires ARC_PRIVATE_KEY in env — only for sending.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, ARC_TESTNET_RPC } from "./constants.js";

export function publicClient(rpcUrl: string = ARC_TESTNET_RPC): PublicClient {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  });
}

export function walletClient(
  privateKey: Hex,
  rpcUrl: string = ARC_TESTNET_RPC,
): WalletClient {
  if (!privateKey || !privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error(
      "Invalid ARC_PRIVATE_KEY. Expected 0x-prefixed 32-byte hex string (66 chars total).",
    );
  }
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(rpcUrl),
  });
}
