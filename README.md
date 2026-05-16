# arc-agent-kit

[![CI](https://github.com/your-handle/arc-agent-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/your-handle/arc-agent-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

A typed toolkit that lets **LLM agents transact on [Arc Network](https://arc.network)** — Circle's stablecoin-native L1. Ships:

- A **viem-based SDK** for balances, transfers, simulation, and CCTP queries
- An **MCP server** so Claude Desktop / Cursor / any MCP client can drive Arc directly
- A **CLI** (`arc balance`, `arc send-usdc`, …) for humans
- **Anthropic / OpenAI function-call schemas** for embedding in your own agents
- **x402 payment client** — agents auto-pay HTTP `402 Payment Required` responses in USDC on Arc
- A safe **wallet generator** that never prints the private key

> Status: working on Arc public testnet (chain id `5042002`). No security review. Use testnet funds only.

## Live on testnet

Verified end-to-end against Arc public testnet on 2026-05-16:

| | |
|---|---|
| **Tx hash** | [`0xa6c443646197046ac27fb7f11a1ead6163401db1339f73df38da78afd1e83a75`](https://testnet.arcscan.app/tx/0xa6c443646197046ac27fb7f11a1ead6163401db1339f73df38da78afd1e83a75) |
| Block | `42432006` |
| Status | ✅ success |
| Amount | 0.01 USDC |
| Fee | 0.00042 USDC |
| Simulation accuracy | exact — `simulate_send_usdc` predicted the fee to 18 decimal places before broadcasting |

## Why this exists

Arc went public testnet with a focus on stablecoin payments, AI-driven economic coordination, and CCTP-powered cross-chain flows. Most of that surface is reachable through plain EVM tools — but agents need typed, sandboxed primitives, simulation before send, and an MCP transport to actually be useful. This kit packages that.

## 30-second tour

```bash
git clone https://github.com/<you>/arc-agent-kit && cd arc-agent-kit
npm install
cp .env.example .env

npm run gen-wallet                 # generates a key — never prints it
open https://faucet.circle.com     # fund the printed address

npx arc info                       # chain + signer info
npx arc balance 0xYourAddress      # USDC + EURC
npx arc simulate-usdc 0xFrom 0xTo 0.5   # dry-run, no spend
npx arc send-usdc 0xTo 0.01        # real transfer on testnet
npx arc tx 0xHash                  # confirm it landed
```

Add to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arc": {
      "command": "npx",
      "args": ["arc-agent-kit", "arc-mcp"],
      "env": { "ARC_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Now Claude can run any of these tools from any conversation:

```
arc_chain_info · arc_get_usdc_balance · arc_get_eurc_balance
arc_get_transaction_status · arc_simulate_send_usdc · arc_simulate_send_eurc
arc_cctp_info · arc_send_usdc · arc_send_eurc
```

## What's in the box

```
src/
  constants.ts      Arc chain config, contract addresses, viem Chain object
  client.ts         publicClient() / walletClient()
  tools.ts          balance, transfer, status, explorer links
  simulate.ts       Pre-flight: estimateGas + simulate + fee preview
  cctp.ts           CCTP V2 contracts, domain IDs, getArcDomain() query
  x402.ts           HTTP 402 paid-fetch client wired to an Arc wallet
  agent-tools.ts    Anthropic-shape tool schemas + dispatchTool()
  openai-tools.ts   OpenAI-shape tool schemas + dispatchOpenAIToolCall()
  mcp.ts            MCP server (stdio) exposing every tool
  index.ts          Public re-exports

bin/
  arc.ts            CLI entry — npx arc <command>
  arc-mcp.ts        MCP server entry — npx arc-mcp
  gen-wallet.ts     Safe wallet generation; private key only to .env (0600)

examples/
  check-balance.ts  Read-only
  send-usdc.ts      Native USDC transfer
  send-eurc.ts      ERC-20 EURC transfer
  simulate-send.ts  Dry-run preview
  claude-agent.ts   Full Claude agent loop with prompt caching

test/
  tools.test.ts     Smoke tests, no network/key required
```

## Arc testnet facts this repo depends on

Sourced from [docs.arc.network](https://docs.arc.network) — pinned in [`src/constants.ts`](./src/constants.ts).

| | Value |
|---|---|
| RPC | `https://rpc.testnet.arc.network` |
| Chain ID | `5042002` (`0x4CEF52`) |
| Native currency | USDC, **18 decimals** |
| Explorer | `https://testnet.arcscan.app` |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| CCTP V2 TokenMessenger | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| Faucet | `https://faucet.circle.com` |

**Decimals gotcha**: native USDC on Arc is 18-decimals (EVM precompile convention), while bridged ERC-20 USDC on other chains is 6. This kit's `sendUSDC` takes a decimal string (`"0.5"`) and handles the unit math — never multiply by `10^18` yourself.

## Using it as a library

```ts
import {
  publicClient,
  walletClient,
  getUSDCBalance,
  sendUSDC,
  simulateSendUSDC,
  formatSimulation,
} from "arc-agent-kit";

const pub = publicClient();
console.log(await getUSDCBalance(pub, "0xabc…"));    // "12.34"

const wallet = walletClient(process.env.ARC_PRIVATE_KEY!);
const sim = await simulateSendUSDC(pub, wallet.account!.address, "0xdef…", "0.5");
console.log(formatSimulation(sim));

const { hash, explorerUrl } = await sendUSDC(wallet, "0xdef…", "0.5");
console.log(`Sent: ${explorerUrl}`);
```

## Using it with Claude or GPT (or any function-calling LLM)

Same toolkit, two wire-compatible shapes.

### Claude (Anthropic SDK)

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  arcAgentTools,
  dispatchTool,
  publicClient,
  walletClient,
} from "arc-agent-kit";

const anthropic = new Anthropic();
const deps = {
  pub: publicClient(),
  wallet: walletClient(process.env.ARC_PRIVATE_KEY!),
};

// ... model loop: for each tool_use block, call dispatchTool(name, input, deps)
//     and feed the result back as tool_result. See examples/claude-agent.ts.
```

### GPT (OpenAI SDK — also works with LiteLLM, Ollama, vLLM, any OpenAI-API drop-in)

```ts
import OpenAI from "openai";
import {
  arcAgentToolsOpenAI,
  dispatchOpenAIToolCalls,
  publicClient,
  walletClient,
} from "arc-agent-kit";

const openai = new OpenAI();
const deps = {
  pub: publicClient(),
  wallet: walletClient(process.env.ARC_PRIVATE_KEY!),
};

const response = await openai.chat.completions.create({
  model: "gpt-5",
  tools: arcAgentToolsOpenAI,
  messages: [{ role: "user", content: "What's my USDC balance on Arc?" }],
});

const toolCalls = response.choices[0]?.message.tool_calls ?? [];
const toolMessages = await dispatchOpenAIToolCalls(toolCalls, deps);
// Append toolMessages to the conversation, ask the model again, repeat.
```

Tool names, descriptions, and parameter schemas are identical across providers — prompts and agent behavior stay portable.

## Paying for HTTP APIs via x402

[x402](https://github.com/coinbase/x402) is Coinbase's HTTP-native payment protocol — a server replies with `402 Payment Required`, the client signs a payment authorization, and the server fulfills the original request. This kit wires x402's client SDK to an Arc testnet wallet, so any agent can transparently pay per API call in USDC.

```ts
import { createArcPaidFetch } from "arc-agent-kit";

const paidFetch = createArcPaidFetch(process.env.ARC_PRIVATE_KEY!);

// Behaves like normal fetch — but if the server replies 402, an EIP-712
// payment authorization is signed and the request is retried automatically.
const response = await paidFetch("https://api.example.com/paid-endpoint");
console.log(await response.json());
```

The same capability is also exposed as:

- An MCP tool: **`arc_pay_x402`** (drop into Claude Desktop and your agent can hit paywalled APIs)
- An Anthropic / OpenAI function-call schema: **`pay_x402`**
- A CLI-friendly example: `npm run example:x402 -- https://api.example.com/...`

**Server-side gap**: x402 requires a *facilitator* to verify and settle payments. The public Coinbase facilitator does not yet advertise Arc testnet support — the client-side flow signs correctly, but third-party servers will fail at the verify step until Arc is listed (or you self-host a facilitator pointed at an Arc RPC). This is a server-side ecosystem gap, not a limitation of this module.

## Using it from any MCP client

The `arc-mcp` binary speaks MCP over stdio. Any client that supports MCP (Claude Desktop, Cursor, Cline, Zed, custom hosts via the official SDK) can attach to it. Configuration shown above for Claude Desktop; the pattern is the same elsewhere.

If you don't pass `ARC_PRIVATE_KEY`, the server starts in **read-only mode** — `arc_get_*` and simulation tools work, but `arc_send_*` refuses. Useful for letting Claude *browse* Arc without giving it spending power.

## Architecture

```
       ┌─────────────────────────┐
       │  Claude / Cursor / app  │
       └────────────┬────────────┘
                    │
       ┌────────────┴────────────┐
       │   MCP stdio transport   │   bin/arc-mcp.ts
       └────────────┬────────────┘
                    │
       ┌────────────┴────────────┐
       │       src/mcp.ts        │
       │  buildServer({pk?, rpc?})│
       └────────────┬────────────┘
                    │
   ┌────────────────┼────────────────┐
   │                │                │
┌──┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐
│ tools.ts│  │ simulate.ts │  │   cctp.ts   │
└──┬──────┘  └──────┬──────┘  └──────┬──────┘
   │                │                │
   └────────────────┼────────────────┘
                    │
         ┌──────────┴──────────┐
         │   src/client.ts     │   viem publicClient / walletClient
         └──────────┬──────────┘
                    │
            ┌───────┴───────┐
            │ Arc testnet   │   https://rpc.testnet.arc.network
            └───────────────┘
```

The CLI (`bin/arc.ts`) sits on the same tools/simulate/cctp layer — no logic duplication.

## Security notes

- **Testnet only.** No audit, no security review. Don't reuse keys that hold mainnet balances.
- `gen-wallet` creates `.env` with mode `0600`; the private key never reaches stdout/stderr.
- `.env` is in `.gitignore` — confirm before pushing.
- The Claude agent loop has a `MAX_TURNS` cap so a confused model can't drain a wallet across thousands of calls. Still, only fund the signing wallet with what you can afford to lose.
- Always `simulate-*` before a `send-*` in critical paths — viem will surface revert reasons.

## Roadmap

- [x] **x402 paid-fetch client** — agents auto-pay 402 Payment Required in USDC on Arc
- [x] **OpenAI function-call schemas + dispatcher** — full GPT / LiteLLM / vLLM parity with the Anthropic surface
- [ ] x402 server-side example (Hono / Express middleware using Arc as the settlement chain)
- [ ] CCTP V2 burn helper for Arc-side `depositForBurn`
- [ ] Iris attestation polling + dest-chain `receiveMessage` orchestration
- [ ] Gateway deposit / withdraw flow
- [ ] Recurring-payment primitive (subscriptions, drip)
- [ ] Hardhat plugin: one-command Arc deploys
- [ ] Web demo: a payment-link generator (Stripe Checkout-style) backed by `simulate_send_usdc`

Issues and PRs welcome.

## License

MIT — see [LICENSE](./LICENSE).
