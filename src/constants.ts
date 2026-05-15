/**
 * Arc Network testnet constants.
 * Source: https://docs.arc.network/arc/references/connect-to-arc
 *         https://docs.arc.network/arc/references/contract-addresses
 */

import { defineChain } from "viem";

export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";
export const ARC_TESTNET_EXPLORER = "https://testnet.arcscan.app";
export const ARC_TESTNET_CHAIN_ID = 5042002;

/**
 * Native gas token on Arc is USDC, with 18 decimals at the EVM precompile.
 * The bridged ERC-20 USDC on other chains uses 6 decimals — beware when
 * formatting cross-chain amounts.
 */
export const ARC_NATIVE_DECIMALS = 18;

/** ERC-20 mirror of native USDC. Used for `balanceOf` / `transfer` ABI calls. */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

/** EURC is a standard ERC-20 (not native gas). */
export const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;
export const EURC_DECIMALS = 6;

/** CCTP V2 contracts on Arc testnet. */
export const CCTP = {
  TokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  MessageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  TokenMinterV2: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
  MessageV2: "0xbaC0179bB358A8936169a63408C8481D582390C4",
} as const;

export const FAUCET_URL = "https://faucet.circle.com";

/**
 * viem `Chain` for Arc testnet. Pass to `createPublicClient` / `createWalletClient`.
 */
export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USD Coin",
    symbol: "USDC",
    decimals: ARC_NATIVE_DECIMALS,
  },
  rpcUrls: {
    default: { http: [ARC_TESTNET_RPC] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: ARC_TESTNET_EXPLORER },
  },
  testnet: true,
});
