/**
 * Model Context Protocol server for Arc Network.
 *
 * Run via stdio for use with Claude Desktop / Cursor / Cline / any MCP client.
 * The executable wrapper at `bin/arc-mcp.ts` wires this up.
 *
 * Register with Claude Desktop by adding to ~/.../claude_desktop_config.json:
 *
 *   {
 *     "mcpServers": {
 *       "arc": {
 *         "command": "npx",
 *         "args": ["arc-agent-kit", "arc-mcp"],
 *         "env": { "ARC_PRIVATE_KEY": "0x..." }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Address, Hex } from "viem";
import { publicClient, walletClient } from "./client.js";
import {
  getUSDCBalance,
  getEURCBalance,
  sendUSDC,
  sendEURC,
  getTransactionStatus,
  addressLink,
  explorerLink,
} from "./tools.js";
import {
  simulateSendUSDC,
  simulateSendEURC,
  formatSimulation,
} from "./simulate.js";
import { getArcDomain, getCctpContracts } from "./cctp.js";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER,
  FAUCET_URL,
} from "./constants.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "expected 0x-prefixed 40-hex-char address");
const amountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "expected decimal string like '1.5' or '0.01'");
const txHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "expected 0x-prefixed 64-hex-char tx hash");

export interface BuildServerOptions {
  /** Optional private key. Without it, write tools refuse but reads still work. */
  privateKey?: Hex;
  rpcUrl?: string;
}

export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "arc-agent-kit",
    version: "0.1.0",
  });

  const pub = publicClient(opts.rpcUrl);
  const wallet = opts.privateKey
    ? walletClient(opts.privateKey, opts.rpcUrl)
    : undefined;
  const signerAddress = wallet?.account?.address;

  // -------------------- read tools (always available) --------------------

  server.tool(
    "arc_chain_info",
    "Returns Arc testnet chain ID, RPC, explorer, faucet, and—if a signing wallet is configured—the signer's address.",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              chainId: ARC_TESTNET_CHAIN_ID,
              explorer: ARC_TESTNET_EXPLORER,
              faucet: FAUCET_URL,
              signer: signerAddress ?? null,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.tool(
    "arc_get_usdc_balance",
    "Read the native USDC balance (Arc's gas token) at a given address. Returns decimal string.",
    { address: addressSchema },
    async ({ address }) => {
      const balance = await getUSDCBalance(pub, address as Address);
      return {
        content: [
          {
            type: "text",
            text: `${balance} USDC at ${address}\n${addressLink(address as Address)}`,
          },
        ],
      };
    },
  );

  server.tool(
    "arc_get_eurc_balance",
    "Read the EURC (ERC-20) balance at a given address.",
    { address: addressSchema },
    async ({ address }) => {
      const balance = await getEURCBalance(pub, address as Address);
      return {
        content: [{ type: "text", text: `${balance} EURC at ${address}` }],
      };
    },
  );

  server.tool(
    "arc_get_transaction_status",
    "Check if a transaction landed. Returns 'success', 'reverted', or 'pending', with block number and explorer link.",
    { hash: txHashSchema },
    async ({ hash }) => {
      const status = await getTransactionStatus(pub, hash as Hex);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...status,
                blockNumber: status.blockNumber?.toString() ?? null,
                gasUsed: status.gasUsed?.toString() ?? null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // -------------------- simulation (always available) --------------------

  server.tool(
    "arc_simulate_send_usdc",
    "Dry-run a native USDC transfer without spending. Returns gas estimate and total fee in USDC, or the revert reason.",
    {
      from: addressSchema,
      to: addressSchema,
      amount: amountSchema,
    },
    async ({ from, to, amount }) => {
      const sim = await simulateSendUSDC(
        pub,
        from as Address,
        to as Address,
        amount,
      );
      return { content: [{ type: "text", text: formatSimulation(sim) }] };
    },
  );

  server.tool(
    "arc_simulate_send_eurc",
    "Dry-run an EURC transfer. Returns gas estimate and fee, or the revert reason.",
    {
      from: addressSchema,
      to: addressSchema,
      amount: amountSchema,
    },
    async ({ from, to, amount }) => {
      const sim = await simulateSendEURC(
        pub,
        from as Address,
        to as Address,
        amount,
      );
      return { content: [{ type: "text", text: formatSimulation(sim) }] };
    },
  );

  // -------------------- CCTP read --------------------

  server.tool(
    "arc_cctp_info",
    "Returns CCTP V2 contract addresses on Arc and Arc's CCTP domain ID (queried from the on-chain TokenMessengerV2).",
    {},
    async () => {
      const [domain, contracts] = await Promise.all([
        getArcDomain(pub),
        Promise.resolve(getCctpContracts()),
      ]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ arcDomain: domain, contracts }, null, 2),
          },
        ],
      };
    },
  );

  // -------------------- write tools (require key) --------------------

  server.tool(
    "arc_send_usdc",
    "Send native USDC. Requires a configured signing wallet. Amount is a decimal string (e.g. '0.5'). Always simulate first.",
    {
      to: addressSchema,
      amount: amountSchema,
    },
    async ({ to, amount }) => {
      if (!wallet) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No signing wallet configured. Start arc-mcp with ARC_PRIVATE_KEY set.",
            },
          ],
        };
      }
      const { hash, explorerUrl } = await sendUSDC(
        wallet,
        to as Address,
        amount,
      );
      return {
        content: [{ type: "text", text: `Sent. ${hash}\n${explorerUrl}` }],
      };
    },
  );

  server.tool(
    "arc_send_eurc",
    "Send EURC (ERC-20). Requires signing wallet.",
    {
      to: addressSchema,
      amount: amountSchema,
    },
    async ({ to, amount }) => {
      if (!wallet) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No signing wallet configured. Start arc-mcp with ARC_PRIVATE_KEY set.",
            },
          ],
        };
      }
      const { hash, explorerUrl } = await sendEURC(
        wallet,
        to as Address,
        amount,
      );
      return {
        content: [{ type: "text", text: `Sent. ${hash}\n${explorerUrl}` }],
      };
    },
  );

  return server;
}

/** Start the MCP server on stdio. Called by `bin/arc-mcp.ts`. */
export async function startStdioServer(opts: BuildServerOptions): Promise<void> {
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Re-export viem types so consumers can stay typesafe.
export type { Address, Hex };
// Helper for tests that want to introspect generated explorer links.
export { explorerLink };
