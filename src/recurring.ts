/**
 * Recurring payment scheduler — off-chain subscription primitive for Arc.
 *
 * Arc has no native smart-contract subscription system yet. This module
 * implements the same end-user behavior off-chain: a JSON-persisted list
 * of subscriptions, each describing "send X USDC to recipient every N
 * seconds, starting at T". A scheduler tick loop wakes periodically,
 * finds due subscriptions, simulates the transfer (gas + revert preview),
 * then signs and broadcasts the actual transfer.
 *
 * Designed to be driven by an autonomous agent: the agent owns the
 * private key, the file lives in the agent's filesystem, and the agent
 * can list / create / cancel subscriptions via the CLI or MCP tools.
 *
 * Trade-offs vs an on-chain contract:
 *   + No deployment, no audit surface, ships today on any EVM-compatible chain
 *   + Off-chain logic is in user-readable TS — easy to extend (caps, allowlists)
 *   - Requires the agent to be online when a subscription is due
 *   - No on-chain enforcement: a payer can stop their agent and stop paying
 *
 * This is the right starting point for *agent-managed* recurring payments.
 * For "trustless recurring", a smart-contract version (Permit2 + cron) is
 * a separate workstream.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { sendUSDC, getUSDCBalance, type TxResult } from "./tools.js";
import {
  simulateSendUSDC,
  type SimulationResult,
} from "./simulate.js";

export interface Subscription {
  /** Stable, unguessable id (12 hex chars). */
  id: string;
  /** Recipient address. */
  to: Address;
  /** USDC amount per tick, as a decimal string ("0.5" = 0.5 USDC). */
  amount: string;
  /** Interval between ticks, in seconds. */
  intervalSeconds: number;
  /** When this sub started (unix ms). */
  startedAt: number;
  /** When the next charge is due (unix ms). */
  nextRunAt: number;
  /** Last successful charge timestamp, or null if none yet. */
  lastRunAt: number | null;
  /** Last successful tx hash, or null if none yet. */
  lastTxHash: Hex | null;
  /** Optional human-readable label. */
  label?: string;
  /** Total ticks executed so far. */
  ticks: number;
  /** Max ticks before auto-cancel (omit = unlimited). */
  maxTicks?: number;
  /** Cumulative cap: total USDC spend over the life of this subscription. */
  cumulativeCap?: string;
  /** Soft state — `active` runs, `paused` skips, `cancelled` removes on next save. */
  status: "active" | "paused" | "cancelled";
}

export interface SubscriptionStore {
  version: 1;
  subscriptions: Subscription[];
}

export interface TickResult {
  subscriptionId: string;
  outcome: "ran" | "skipped-not-due" | "skipped-paused" | "skipped-cap-hit" | "failed";
  txHash?: Hex;
  explorerUrl?: string;
  blockNumber?: bigint;
  feeUSDC?: string;
  reason?: string;
}

export const DEFAULT_STORE_PATH = resolve(
  homedir(),
  ".arc-agent-kit",
  "subscriptions.json",
);

/* -------------------- persistence -------------------- */

export function loadStore(path: string = DEFAULT_STORE_PATH): SubscriptionStore {
  if (!existsSync(path)) {
    return { version: 1, subscriptions: [] };
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<SubscriptionStore>;
  if (parsed.version !== 1 || !Array.isArray(parsed.subscriptions)) {
    throw new Error(
      `Subscription store at ${path} has unexpected shape — refusing to use.`,
    );
  }
  return parsed as SubscriptionStore;
}

export function saveStore(
  store: SubscriptionStore,
  path: string = DEFAULT_STORE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Drop cancelled subs on persist — they tombstone after one save cycle.
  const cleaned: SubscriptionStore = {
    version: 1,
    subscriptions: store.subscriptions.filter((s) => s.status !== "cancelled"),
  };
  writeFileSync(path, JSON.stringify(cleaned, null, 2), { mode: 0o600 });
}

/* -------------------- CRUD -------------------- */

export interface CreateSubscriptionInput {
  to: Address;
  amount: string;
  intervalSeconds: number;
  label?: string;
  maxTicks?: number;
  cumulativeCap?: string;
  startAt?: number;
}

export function createSubscription(
  store: SubscriptionStore,
  input: CreateSubscriptionInput,
): Subscription {
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.to)) {
    throw new Error(`Invalid recipient address: ${input.to}`);
  }
  if (!/^\d+(\.\d+)?$/.test(input.amount) || parseFloat(input.amount) <= 0) {
    throw new Error(`Invalid amount: ${input.amount} (must be positive decimal)`);
  }
  if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds < 60) {
    throw new Error(
      `intervalSeconds must be >= 60 (got ${input.intervalSeconds}). Sub-minute schedules are reserved for testing.`,
    );
  }
  const now = Date.now();
  const sub: Subscription = {
    id: randomBytes(6).toString("hex"),
    to: input.to,
    amount: input.amount,
    intervalSeconds: input.intervalSeconds,
    startedAt: input.startAt ?? now,
    nextRunAt: input.startAt ?? now,
    lastRunAt: null,
    lastTxHash: null,
    label: input.label,
    ticks: 0,
    maxTicks: input.maxTicks,
    cumulativeCap: input.cumulativeCap,
    status: "active",
  };
  store.subscriptions.push(sub);
  return sub;
}

export function findSubscription(
  store: SubscriptionStore,
  id: string,
): Subscription | undefined {
  return store.subscriptions.find((s) => s.id === id);
}

export function setStatus(
  store: SubscriptionStore,
  id: string,
  status: Subscription["status"],
): Subscription {
  const sub = findSubscription(store, id);
  if (!sub) throw new Error(`No subscription with id ${id}`);
  sub.status = status;
  return sub;
}

/* -------------------- scheduler -------------------- */

/**
 * Run one scheduler tick: for each active subscription that is due, simulate
 * then send. Returns a per-subscription result list. Persists the store at
 * the end (so lastRunAt / nextRunAt are durable).
 */
export async function tickOnce(
  store: SubscriptionStore,
  wallet: WalletClient,
  pub: PublicClient,
  storePath: string = DEFAULT_STORE_PATH,
  now: number = Date.now(),
): Promise<TickResult[]> {
  const results: TickResult[] = [];
  if (!wallet.account) {
    throw new Error("wallet has no account — tickOnce needs a signing wallet");
  }
  const from = wallet.account.address;

  for (const sub of store.subscriptions) {
    if (sub.status !== "active") {
      results.push({ subscriptionId: sub.id, outcome: "skipped-paused" });
      continue;
    }
    if (now < sub.nextRunAt) {
      results.push({ subscriptionId: sub.id, outcome: "skipped-not-due" });
      continue;
    }
    if (sub.maxTicks !== undefined && sub.ticks >= sub.maxTicks) {
      sub.status = "cancelled";
      results.push({
        subscriptionId: sub.id,
        outcome: "skipped-cap-hit",
        reason: `reached maxTicks=${sub.maxTicks}`,
      });
      continue;
    }
    if (sub.cumulativeCap !== undefined) {
      const spent = parseFloat(sub.amount) * sub.ticks;
      const cap = parseFloat(sub.cumulativeCap);
      if (spent + parseFloat(sub.amount) > cap) {
        sub.status = "cancelled";
        results.push({
          subscriptionId: sub.id,
          outcome: "skipped-cap-hit",
          reason: `would exceed cumulativeCap=${sub.cumulativeCap}`,
        });
        continue;
      }
    }

    // Pre-flight: simulate first. If it would revert, mark failure and
    // advance nextRunAt so we don't hot-loop on a broken sub.
    const sim: SimulationResult = await simulateSendUSDC(
      pub,
      from,
      sub.to,
      sub.amount,
    );
    if (!sim.ok) {
      sub.nextRunAt = now + sub.intervalSeconds * 1000;
      results.push({
        subscriptionId: sub.id,
        outcome: "failed",
        reason: `simulate failed: ${sim.reason ?? "unknown"}`,
      });
      continue;
    }

    // Real send.
    let tx: TxResult;
    try {
      tx = await sendUSDC(wallet, sub.to, sub.amount);
    } catch (err) {
      sub.nextRunAt = now + sub.intervalSeconds * 1000;
      results.push({
        subscriptionId: sub.id,
        outcome: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    sub.lastRunAt = now;
    sub.lastTxHash = tx.hash;
    sub.ticks += 1;
    sub.nextRunAt = now + sub.intervalSeconds * 1000;
    results.push({
      subscriptionId: sub.id,
      outcome: "ran",
      txHash: tx.hash,
      explorerUrl: tx.explorerUrl,
      feeUSDC: sim.feeUSDC ?? undefined,
    });
  }

  saveStore(store, storePath);
  return results;
}

/**
 * Pre-flight: would the configured signer wallet have enough USDC to honor
 * every active subscription's next charge? Returns a summary suitable for
 * surfacing to the user before they walk away.
 */
export async function previewNextWindow(
  store: SubscriptionStore,
  pub: PublicClient,
  signerAddress: Address,
): Promise<{
  balanceUSDC: string;
  requiredNext: string;
  willCoverNext: boolean;
  activeCount: number;
}> {
  const balance = await getUSDCBalance(pub, signerAddress);
  const required = store.subscriptions
    .filter((s) => s.status === "active")
    .reduce((sum, s) => sum + parseFloat(s.amount), 0);
  return {
    balanceUSDC: balance,
    requiredNext: required.toFixed(18),
    willCoverNext: parseFloat(balance) >= required,
    activeCount: store.subscriptions.filter((s) => s.status === "active").length,
  };
}

/**
 * Run the scheduler forever, ticking every `intervalSeconds` (default 60s).
 * Stops only on SIGINT/SIGTERM or an unhandled error.
 */
export async function runForever(
  storePath: string,
  wallet: WalletClient,
  pub: PublicClient,
  tickIntervalSeconds = 60,
  onTick?: (results: TickResult[]) => void,
): Promise<void> {
  let stop = false;
  const handleStop = () => {
    stop = true;
  };
  process.on("SIGINT", handleStop);
  process.on("SIGTERM", handleStop);

  while (!stop) {
    const store = loadStore(storePath);
    const results = await tickOnce(store, wallet, pub, storePath);
    if (onTick) onTick(results);
    if (stop) break;
    await new Promise((r) => setTimeout(r, tickIntervalSeconds * 1000));
  }

  process.off("SIGINT", handleStop);
  process.off("SIGTERM", handleStop);
}

/** Convenience: parse a human-readable duration like "30s", "5m", "1h", "1d" into seconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(input.trim());
  if (!m) throw new Error(`Cannot parse duration: ${input}`);
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] ?? "s").toLowerCase();
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return n * factor;
}
