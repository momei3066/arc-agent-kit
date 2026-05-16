# Notes for AI assistants working on arc-agent-kit

Read this before editing. It captures the architecture decisions that aren't obvious from the code alone.

## What this kit is

A toolkit so LLM agents can transact on **Arc Network** — Circle's stablecoin-native L1 (testnet chain id `5042002`). One repo, four surfaces:

1. **viem-based SDK** (`src/tools.ts`, `src/simulate.ts`, `src/cctp.ts`, `src/x402.ts`)
2. **MCP server** over stdio (`src/mcp.ts`, run via `bin/arc-mcp.ts`)
3. **CLI** (`bin/arc.ts`)
4. **Anthropic / OpenAI function-call schemas** (`src/agent-tools.ts`)

Every surface delegates to the SDK — never reimplement business logic in the CLI or MCP layer.

## Critical project facts

| | Value | Why it matters |
|---|---|---|
| Native gas token | **USDC at 18 decimals** | Bridged ERC-20 USDC on other chains is 6 decimals. Mixing these up corrupts amounts by 10^12. `src/constants.ts` exports `ARC_NATIVE_DECIMALS = 18` and `EURC_DECIMALS = 6` — use them. |
| RPC | `https://rpc.testnet.arc.network` | Pinned in `constants.ts`; `ARC_RPC_URL` env var overrides. |
| Explorer | `https://testnet.arcscan.app` | Used for `explorerLink()` / `addressLink()` helpers. |
| CCTP `localDomain()` | **reverts on Arc** | `getArcDomain()` in `cctp.ts` returns `null` gracefully — don't change to throw. |
| x402 facilitator | Coinbase facilitator doesn't yet list Arc | Client-side flow signs correctly; server-side end-to-end fails at verify until Arc is listed. Document this in any new x402 code. |

## Development loop

```bash
npm install           # one-time
npm run typecheck     # `tsc --noEmit` — strict mode
npm test              # 11 smoke tests, no network or key required
npm run build         # tsc → dist/
```

After editing source, **always run typecheck + test** before committing. CI (`.github/workflows/ci.yml`) runs both on Node 20 & 22.

## Conventions

- **TypeScript strict mode**. `noUncheckedIndexedAccess` is on.
- **ESM only**. `package.json` has `"type": "module"`. Import paths use the `.js` extension even when importing `.ts` files — that's the bundler-resolution convention this repo uses.
- **No throwing for expected misses**. Read functions return null/undefined; only invalid input throws (see `walletClient` arg validation).
- **No real private keys in code or git**. `.env` is gitignored. `bin/gen-wallet.ts` writes the key to `.env` (mode 0600) and never prints it.
- **Amounts are decimal strings at the API boundary** (`"1.5"` not `BigInt`). Internal conversion via viem's `parseUnits` / `formatUnits`. Don't bubble bigints out of the SDK.

## Adding a new operation — the four-surface checklist

When you add a new core operation (e.g. `swapUSDCtoEURC`), wire it through every surface so callers can reach it however they want:

1. **SDK** — add the function in the appropriate `src/*.ts` module
2. **CLI** — add a `case` in `bin/arc.ts` that calls the SDK function
3. **MCP** — add a `server.tool(...)` block in `src/mcp.ts` with a zod schema
4. **Agent tools** — add an entry to `arcAgentTools` and a `case` in `dispatchTool` in `src/agent-tools.ts`
5. **Example** — add a runnable example in `examples/`
6. **Test** — at least a smoke test in `test/tools.test.ts` (no network required)
7. **README** — bump the table of contents / surface list

## Where things live (quick map)

```
src/
  constants.ts      Arc testnet chain config, contract addresses, viem Chain object
  client.ts         publicClient() / walletClient() factories
  tools.ts          balance reads, transfers, status, explorer links
  simulate.ts       Pre-flight estimateGas + simulate, returns SimulationResult
  cctp.ts           CCTP V2 contracts + canonical foreign domain IDs
  x402.ts           HTTP-402 paid fetch wired to an Arc wallet
  agent-tools.ts    Anthropic/OpenAI function-call schemas + dispatcher
  mcp.ts            MCP server (stdio); buildServer({privateKey?, rpcUrl?})
  index.ts          Public re-exports

bin/
  arc.ts            CLI entry — npx arc <subcommand>
  arc-mcp.ts        MCP server entry — npx arc-mcp
  gen-wallet.ts     Safe wallet generation; key only ever goes to .env (0600)

examples/           Standalone runnable demos for each capability
test/               Node native --test runner; no network required
.github/workflows/  CI: typecheck + test + build on Node 20/22
```

## Common foot-guns

- **Sending to `0xDEad...BEEF` mixed case fails** viem's EIP-55 checksum check. Use lowercase or compute the proper checksum. (Real-world recipients almost always have the right checksum already.)
- **`createWalletClient(...)` does NOT have `.address` at top level** — it's `client.account.address`. The x402 `ClientEvmSigner` type expects `address` flat, so we compose the signer object manually in `src/x402.ts`.
- **`tsconfig.json` `include` must list `bin/**/*`** or the CLI doesn't get compiled into `dist/bin/`. The `bin` entries in `package.json` then 404.
- **Set type narrowing**: `new Set([...as const])` produces a typed Set whose `.has()` only accepts those literal types. Cast to `Set<string>` if you need to look up arbitrary strings.

## When in doubt

- Look at `examples/` — every capability has a runnable example
- Look at `test/tools.test.ts` — every public function should have at least one smoke test
- Check Arc docs: https://docs.arc.network — especially the contract-addresses page

## License

MIT. Add your name to LICENSE if you contribute substantively.
