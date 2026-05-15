/**
 * Anthropic-style tool schemas + a dispatcher so an LLM can drive
 * the operations defined in `tools.ts`.
 *
 * Schemas are written in Anthropic's tool-use JSON Schema dialect
 * (https://docs.anthropic.com/en/docs/build-with-claude/tool-use).
 * They translate one-to-one to OpenAI function-calling — copy the
 * `name`, `description`, `input_schema` fields and rename
 * `input_schema` → `parameters` if you need the OpenAI shape.
 */

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import {
  getUSDCBalance,
  getEURCBalance,
  sendUSDC,
  sendEURC,
  getTransactionStatus,
} from "./tools.js";

export const arcAgentTools = [
  {
    name: "get_usdc_balance",
    description:
      "Get the native USDC balance of an address on Arc testnet. USDC is Arc's native gas token. Returns a decimal string.",
    input_schema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "0x-prefixed Ethereum-format address (20 bytes).",
        },
      },
      required: ["address"],
    },
  },
  {
    name: "get_eurc_balance",
    description:
      "Get the EURC (ERC-20) balance of an address on Arc testnet. Returns a decimal string.",
    input_schema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "0x-prefixed Ethereum-format address (20 bytes).",
        },
      },
      required: ["address"],
    },
  },
  {
    name: "send_usdc",
    description:
      "Send native USDC on Arc testnet from the agent's wallet to a recipient address. Returns the transaction hash and a block explorer link. The amount is a human-readable decimal string (e.g. '1.5' = 1.5 USDC).",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient address, 0x-prefixed.",
        },
        amount: {
          type: "string",
          description: "Amount of USDC to send, as a decimal string. Examples: '0.01', '1', '12.345'.",
        },
      },
      required: ["to", "amount"],
    },
  },
  {
    name: "send_eurc",
    description:
      "Send EURC (ERC-20) on Arc testnet from the agent's wallet to a recipient address. Amount is a decimal string.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address, 0x-prefixed." },
        amount: { type: "string", description: "Amount of EURC, decimal string." },
      },
      required: ["to", "amount"],
    },
  },
  {
    name: "get_transaction_status",
    description:
      "Check whether a previously-submitted transaction on Arc testnet has been mined. Returns status ('success' | 'reverted' | 'pending'), block number, and an explorer link.",
    input_schema: {
      type: "object",
      properties: {
        hash: { type: "string", description: "0x-prefixed transaction hash." },
      },
      required: ["hash"],
    },
  },
] as const;

export type AgentToolName = (typeof arcAgentTools)[number]["name"];

export interface DispatchDeps {
  pub: PublicClient;
  /** Required for `send_*` tools. Omit for read-only agents. */
  wallet?: WalletClient;
}

/**
 * Execute a tool call by name with raw input. Returns a stringified result
 * suitable to feed back to the model as a tool_result block.
 */
export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  deps: DispatchDeps,
): Promise<string> {
  try {
    switch (name) {
      case "get_usdc_balance": {
        const balance = await getUSDCBalance(deps.pub, input.address as Address);
        return JSON.stringify({ address: input.address, usdc: balance });
      }
      case "get_eurc_balance": {
        const balance = await getEURCBalance(deps.pub, input.address as Address);
        return JSON.stringify({ address: input.address, eurc: balance });
      }
      case "send_usdc": {
        if (!deps.wallet) {
          return JSON.stringify({ error: "wallet not configured" });
        }
        const res = await sendUSDC(
          deps.wallet,
          input.to as Address,
          input.amount as string,
        );
        return JSON.stringify(res);
      }
      case "send_eurc": {
        if (!deps.wallet) {
          return JSON.stringify({ error: "wallet not configured" });
        }
        const res = await sendEURC(
          deps.wallet,
          input.to as Address,
          input.amount as string,
        );
        return JSON.stringify(res);
      }
      case "get_transaction_status": {
        const res = await getTransactionStatus(deps.pub, input.hash as Hex);
        return JSON.stringify({
          ...res,
          blockNumber: res.blockNumber?.toString() ?? null,
          gasUsed: res.gasUsed?.toString() ?? null,
        });
      }
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
