/**
 * Pre-flight simulation. Run BEFORE a real transaction to surface failures
 * (insufficient balance, would-revert calls) and to show the user a gas/fee
 * estimate they can approve.
 *
 * viem's `publicClient.estimateGas` reverts if execution would fail, so we
 * wrap it in a typed result instead of throwing.
 */

import {
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ARC_NATIVE_DECIMALS,
  EURC_ADDRESS,
  EURC_DECIMALS,
} from "./constants.js";

export interface SimulationResult {
  ok: boolean;
  /** Gas units the EVM would charge. */
  gasUnits: bigint | null;
  /** Per-gas price in wei (USDC native units, 18 decimals). */
  gasPriceWei: bigint | null;
  /** Total fee in USDC, human-readable. */
  feeUSDC: string | null;
  /** When `ok=false`, the revert reason or error. */
  reason?: string;
}

/** Simulate a native USDC transfer (value send). */
export async function simulateSendUSDC(
  pub: PublicClient,
  from: Address,
  to: Address,
  amount: string,
): Promise<SimulationResult> {
  const value = parseUnits(amount, ARC_NATIVE_DECIMALS);
  try {
    const [gasUnits, gasPriceWei] = await Promise.all([
      pub.estimateGas({ account: from, to, value }),
      pub.getGasPrice(),
    ]);
    return {
      ok: true,
      gasUnits,
      gasPriceWei,
      feeUSDC: formatUnits(gasUnits * gasPriceWei, ARC_NATIVE_DECIMALS),
    };
  } catch (err) {
    return {
      ok: false,
      gasUnits: null,
      gasPriceWei: null,
      feeUSDC: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Simulate an EURC (ERC-20) transfer. */
export async function simulateSendEURC(
  pub: PublicClient,
  from: Address,
  to: Address,
  amount: string,
): Promise<SimulationResult> {
  const value = parseUnits(amount, EURC_DECIMALS);
  try {
    // simulateContract dry-runs at latest state and reverts on failure.
    await pub.simulateContract({
      account: from,
      address: EURC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, value],
    });
    const [gasUnits, gasPriceWei] = await Promise.all([
      pub.estimateContractGas({
        account: from,
        address: EURC_ADDRESS,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, value],
      }),
      pub.getGasPrice(),
    ]);
    return {
      ok: true,
      gasUnits,
      gasPriceWei,
      feeUSDC: formatUnits(gasUnits * gasPriceWei, ARC_NATIVE_DECIMALS),
    };
  } catch (err) {
    return {
      ok: false,
      gasUnits: null,
      gasPriceWei: null,
      feeUSDC: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Helper: pretty-print a simulation result for CLI / agent output. */
export function formatSimulation(sim: SimulationResult): string {
  if (!sim.ok) return `❌ would revert: ${sim.reason}`;
  return [
    `✅ would succeed`,
    `   gas units : ${sim.gasUnits}`,
    `   gas price : ${sim.gasPriceWei} wei`,
    `   total fee : ${sim.feeUSDC} USDC`,
  ].join("\n");
}

export type { Hex };
