/**
 * x402 client integration for Arc Network.
 *
 * x402 is Coinbase's HTTP 402 payment protocol — an API server replies with
 * 402 Payment Required, the client signs a payment authorization (USDC on
 * Arc, here), and the server fulfills the original request once payment is
 * verified. This lets LLM agents transparently pay per API call.
 *
 * This module wires the @x402/fetch + @x402/evm SDKs to an Arc testnet
 * wallet so any wrapped fetch call automatically handles 402 responses.
 *
 * --- Caveat worth knowing before you ship to prod ---
 * x402 requires a *facilitator* on the server side to verify and settle
 * payments. As of writing, the public Coinbase facilitator does not yet
 * advertise Arc testnet support. The client-side EIP-712 signing still
 * works against any facilitator, but until Arc is listed (or you self-host
 * a facilitator pointed at Arc RPC), end-to-end flow against a third-party
 * server will fail at the verify step. This is a *server-side* gap, not a
 * limitation of this module — and a clear thing for Circle dev-rel to fix.
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_RPC,
  arcTestnet,
} from "./constants.js";

/** CAIP-2 network identifier for Arc testnet, as consumed by x402. */
export const X402_ARC_NETWORK = `eip155:${ARC_TESTNET_CHAIN_ID}` as const;

/**
 * Build an x402Client wired to pay from a given Arc testnet private key.
 * Returns the client + the derived signer address so callers can log it.
 */
export function buildArcX402Client(
  privateKey: Hex,
  rpcUrl: string = ARC_TESTNET_RPC,
): { client: x402Client; from: Address } {
  if (!privateKey || !privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error(
      "Invalid private key for x402 client. Expected 0x-prefixed 32-byte hex string (66 chars total).",
    );
  }
  const account = privateKeyToAccount(privateKey);
  // ExactEvmScheme needs a ClientEvmSigner — a flat object with `address`
  // + signTypedData (the base flow) and optionally readContract (for the
  // EIP-2612 enrichment path). viem's WalletClient nests address under
  // .account, so we compose the signer shape manually from the account
  // (for signing) and a public client (for chain reads).
  const pub = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  });
  const signer: ClientEvmSigner = {
    address: account.address,
    signTypedData: (msg) =>
      account.signTypedData(msg as Parameters<typeof account.signTypedData>[0]),
    readContract: (args) =>
      pub.readContract(
        args as unknown as Parameters<typeof pub.readContract>[0],
      ),
  };

  const client = new x402Client().register(
    X402_ARC_NETWORK,
    new ExactEvmScheme(signer),
  );
  return { client, from: account.address };
}

/**
 * Create a fetch function that automatically pays via x402 when the server
 * responds with 402 Payment Required. The returned function has the same
 * signature as the global `fetch`.
 *
 *   const paidFetch = createArcPaidFetch(process.env.ARC_PRIVATE_KEY!);
 *   const r = await paidFetch("https://api.example.com/expensive-thing");
 */
export function createArcPaidFetch(
  privateKey: Hex,
  rpcUrl?: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const { client } = buildArcX402Client(privateKey, rpcUrl);
  return wrapFetchWithPayment(fetch, client);
}

/**
 * Make a single GET request to a (potentially) 402-paywalled URL. If the
 * server responds with 402, payment is signed and submitted automatically;
 * the returned Response is the final 200 (or whatever the server returns
 * after payment).
 *
 * Convenience wrapper over `createArcPaidFetch` for one-shot use.
 */
export async function paidGet(
  privateKey: Hex,
  url: string,
  init?: Omit<RequestInit, "method">,
): Promise<Response> {
  const paid = createArcPaidFetch(privateKey);
  return paid(url, { ...init, method: "GET" });
}
