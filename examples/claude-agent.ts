/**
 * Headline demo: a Claude agent that uses the Arc toolkit autonomously.
 *
 *   ANTHROPIC_API_KEY=... ARC_PRIVATE_KEY=... \
 *     npm run example:agent -- "Send 0.05 USDC to 0xRecipient and confirm it landed"
 *
 * The agent has these tools available (defined in src/agent-tools.ts):
 *   - get_usdc_balance / get_eurc_balance
 *   - send_usdc / send_eurc
 *   - get_transaction_status
 *
 * The loop:
 *   1. Send user message + tool definitions to Claude.
 *   2. If Claude returns tool_use blocks, execute each, collect tool_result blocks.
 *   3. Send tool_result back; repeat until end_turn (or MAX_TURNS safety cap).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { Hex } from "viem";
import { publicClient, walletClient } from "../src/client.js";
import { arcAgentTools, dispatchTool } from "../src/agent-tools.js";

const MAX_TURNS = 10;
const MODEL = "claude-sonnet-4-5";

const SYSTEM_PROMPT = `You are an autonomous payments agent operating on Arc Network testnet.

Arc is Circle's stablecoin-native L1. Native gas is USDC (18 decimals). EURC is a standard ERC-20.

Rules:
- Never send more than the user explicitly authorized.
- Always verify the recipient address matches what the user asked for character-for-character.
- After sending a transaction, call get_transaction_status to confirm it landed before reporting success.
- Report transaction hashes and block explorer links in your final answer.
- Amounts are decimal strings ('0.5', '1.25'). Do not multiply by 10^decimals — the tools handle that.`;

async function main() {
  const userMessage = process.argv.slice(2).join(" ");
  if (!userMessage) {
    console.error(
      'Usage: tsx examples/claude-agent.ts "Send 0.05 USDC to 0x..."',
    );
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY in .env");
    process.exit(1);
  }

  const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
  const pub = publicClient(process.env.ARC_RPC_URL);
  const wallet = pk ? walletClient(pk, process.env.ARC_RPC_URL) : undefined;
  if (!wallet) {
    console.warn(
      "[warn] ARC_PRIVATE_KEY not set — agent is read-only. send_* tools will refuse.",
    );
  } else {
    console.log(`[info] Agent wallet: ${wallet.account!.address}`);
  }

  const anthropic = new Anthropic();

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // Cache the static system prompt — it doesn't change between turns
          // and saves cost on subsequent loop iterations.
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: arcAgentTools as unknown as Anthropic.Tool[],
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    // Stream any text blocks to stdout as the agent reasons.
    for (const block of response.content) {
      if (block.type === "text") {
        console.log(`\n[agent] ${block.text}`);
      }
    }

    if (response.stop_reason !== "tool_use") {
      // Agent finished — print stop reason and exit.
      console.log(`\n[done] stop_reason=${response.stop_reason}`);
      return;
    }

    // Execute every tool_use block; collect tool_result blocks for the next turn.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(
        `[tool] ${block.name}(${JSON.stringify(block.input)})`,
      );
      const result = await dispatchTool(
        block.name,
        block.input as Record<string, unknown>,
        { pub, wallet },
      );
      console.log(`[tool] → ${result}`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  console.warn(`[warn] hit MAX_TURNS=${MAX_TURNS} without end_turn`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
