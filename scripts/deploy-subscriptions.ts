/**
 * Compile ArcSubscriptions.sol with solc, deploy to Arc testnet via viem,
 * and write the deployment artifact (ABI + address) to dist/contracts/.
 *
 *   npm run deploy:subscriptions
 *
 * Requires ARC_PRIVATE_KEY in .env, wallet funded with enough USDC for
 * deployment gas (~0.01 USDC plenty).
 */

import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Hex } from "viem";
import { publicClient, walletClient } from "../src/client.js";
import { ARC_TESTNET_EXPLORER } from "../src/constants.js";

// solc is CJS — require it.
const require = createRequire(import.meta.url);
const solc = require("solc") as {
  compile(input: string): string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CONTRACT_PATH = resolve(REPO_ROOT, "contracts", "ArcSubscriptions.sol");
const ARTIFACT_DIR = resolve(REPO_ROOT, "deployments", "arc-testnet");
const ARTIFACT_PATH = resolve(ARTIFACT_DIR, "ArcSubscriptions.json");

interface SolcOutput {
  errors?: { severity: string; formattedMessage: string }[];
  contracts: {
    [file: string]: {
      [name: string]: {
        abi: unknown[];
        evm: { bytecode: { object: string } };
      };
    };
  };
}

function compileContract() {
  const source = readFileSync(CONTRACT_PATH, "utf8");
  const input = {
    language: "Solidity",
    sources: { "ArcSubscriptions.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;

  const fatal = (output.errors ?? []).filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    for (const e of fatal) console.error(e.formattedMessage);
    throw new Error("solc reported errors — aborting deploy");
  }

  const compiled = output.contracts["ArcSubscriptions.sol"]?.ArcSubscriptions;
  if (!compiled) throw new Error("solc didn't produce ArcSubscriptions output");
  return {
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}` as Hex,
  };
}

async function main() {
  const pk = process.env.ARC_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    console.error("Missing ARC_PRIVATE_KEY in .env");
    process.exit(1);
  }

  console.log("Compiling ArcSubscriptions.sol …");
  const { abi, bytecode } = compileContract();
  console.log(`  bytecode: ${bytecode.length} hex chars (${(bytecode.length - 2) / 2} bytes)`);
  console.log(`  abi entries: ${abi.length}`);

  const wallet = walletClient(pk, process.env.ARC_RPC_URL);
  const pub = publicClient(process.env.ARC_RPC_URL);

  console.log(`Deploying from ${wallet.account!.address} …`);
  const hash = await wallet.deployContract({
    account: wallet.account!,
    chain: wallet.chain,
    abi,
    bytecode,
    args: [],
  });
  console.log(`  tx: ${hash}`);
  console.log(`      ${ARC_TESTNET_EXPLORER}/tx/${hash}`);

  console.log("Waiting for confirmation …");
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (!receipt.contractAddress) {
    throw new Error("receipt has no contractAddress — deploy failed");
  }
  console.log(`  block: ${receipt.blockNumber}`);
  console.log(`  status: ${receipt.status}`);
  console.log(`  contract: ${receipt.contractAddress}`);
  console.log(`            ${ARC_TESTNET_EXPLORER}/address/${receipt.contractAddress}`);
  console.log(`  gas used: ${receipt.gasUsed}`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifact = {
    contractName: "ArcSubscriptions",
    address: receipt.contractAddress,
    deployTx: hash,
    deployBlock: receipt.blockNumber.toString(),
    chainId: 5042002,
    abi,
  };
  writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));
  console.log(`Saved artifact → ${ARTIFACT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
