/**
 * CCTP V2 (Cross-Chain Transfer Protocol) helpers for Arc.
 *
 * Read-only helpers are implemented here. The full burn-and-mint flow involves:
 *   1. `depositForBurn` on the source chain's TokenMessengerV2
 *   2. Wait for Circle's Iris attestation service to sign the burn event
 *   3. `receiveMessage` on the destination chain's MessageTransmitterV2
 * That cross-chain orchestration is intentionally left as a roadmap item;
 * see https://docs.arc.network/app-kit/quickstarts/bridge-tokens-across-blockchains
 *
 * What this module gives you today:
 *   - The well-known CCTP domain IDs for every supported chain.
 *   - `getArcDomain()` — queries the deployed TokenMessengerV2 for its
 *     `localDomain()`, so we never hardcode Arc's domain.
 *   - `getCctpContracts()` — exposed addresses for both reading and writing.
 *
 * V2 changes a few things vs V1 — notably Fast Transfer with a fee. The
 * full ABI lives behind `tokenMessengerV2Abi` here; only the read functions
 * are used in this file.
 */

import {
  type Address,
  type PublicClient,
  parseAbi,
} from "viem";
import { CCTP } from "./constants.js";

/**
 * Canonical CCTP domain IDs published by Circle.
 * Source: https://developers.circle.com/stablecoins/supported-domains
 */
export const CCTP_DOMAINS = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  noble: 4,
  solana: 5,
  base: 6,
  polygon: 7,
  sui: 8,
  aptos: 9,
  unichain: 10,
  linea: 11,
  codex: 12,
  sonic: 13,
  worldchain: 14,
  // arc: queried at runtime via getArcDomain() — do not hardcode.
} as const satisfies Record<string, number>;

export type CctpChainName = keyof typeof CCTP_DOMAINS;

/**
 * Candidate ABI for CCTP V2 TokenMessenger. Different deployments expose
 * different read selectors — Arc's deployment does not expose `localDomain()`
 * (verified by direct call: 0x8d3638f4 reverts). We probe multiple candidates
 * and return null if none answer.
 */
export const tokenMessengerV2Abi = parseAbi([
  "function localDomain() view returns (uint32)",
  "function domain() view returns (uint32)",
  "function feeRecipient() view returns (address)",
  "function localMinter() view returns (address)",
]);

/**
 * Query Arc's local CCTP domain from the deployed contract. Returns null if
 * no known read selector answers (Arc's TokenMessengerV2 currently reverts
 * on `localDomain()` — the canonical domain is published off-chain by
 * Circle and should be hardcoded here once confirmed).
 */
export async function getArcDomain(pub: PublicClient): Promise<number | null> {
  for (const fn of ["localDomain", "domain"] as const) {
    try {
      const domain = await pub.readContract({
        address: CCTP.TokenMessengerV2 as Address,
        abi: tokenMessengerV2Abi,
        functionName: fn,
      });
      return Number(domain);
    } catch {
      // try the next selector
    }
  }
  return null;
}

/** Convenience: look up a chain's domain by name (string), case-insensitive. */
export function domainForChain(name: string): number | undefined {
  const key = name.toLowerCase() as CctpChainName;
  return CCTP_DOMAINS[key];
}

/** All deployed CCTP V2 addresses on Arc testnet. */
export function getCctpContracts() {
  return { ...CCTP };
}
