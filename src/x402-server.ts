/**
 * x402 proof-of-payment primitives for Arc Network — server + client.
 *
 * Why this exists. The canonical x402 flow (Coinbase's spec) relies on a
 * *facilitator* to verify an EIP-712 payment authorization and settle it
 * via EIP-3009 transferWithAuthorization. The public Coinbase facilitator
 * does not yet list Arc, so the canonical flow cannot close end-to-end on
 * Arc today. This module ships a simpler variant that *does* close on Arc:
 *
 *   1. Server responds 402 Payment Required with a JSON challenge that
 *      tells the client where to pay (recipient, USDC amount, chainId,
 *      resource path, nonce).
 *   2. Client transfers the USDC on-chain itself (using sendUSDC from this
 *      kit), then retries the original request with an `X-PAYMENT-PROOF`
 *      header carrying the resulting tx hash + the nonce it was asked for.
 *   3. Server independently reads the tx receipt from Arc, checks the
 *      `from` matches the request signer, `to` matches the configured
 *      recipient, the USDC transfer event has the right `value`, and the
 *      nonce hasn't been replayed. If everything checks out, the original
 *      response (200 + body) is returned.
 *
 * This is HTTP-native, account-less, EVM-only, and rides on real on-chain
 * settlement — the same essential properties as x402, minus the facilitator
 * dependency. The trade-off: payment is two transactions worth of latency
 * (client tx + server confirmation read), not the one-shot EIP-3009 flow.
 *
 * When Coinbase ships an Arc-aware facilitator, the canonical exact-EVM
 * scheme will work as a drop-in. Until then, this is the only end-to-end
 * x402-like flow on Arc that an agent can actually use today.
 */

import {
  createPublicClient,
  http,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type Log,
  type WalletClient,
} from "viem";
import {
  ARC_NATIVE_DECIMALS,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_RPC,
  USDC_ADDRESS,
  arcTestnet,
} from "./constants.js";
import { sendUSDC } from "./tools.js";

/** What the server tells the client in the 402 challenge body. */
export interface PaymentChallenge {
  /** Always "arc-proof-of-payment" — clients can branch on this. */
  scheme: "arc-proof-of-payment";
  /** CAIP-2 chain id; clients verify they're paying on the right chain. */
  network: `eip155:${number}`;
  /** Where the USDC must land. */
  recipient: Address;
  /** Decimal-string amount, NOT base units (mirrors sendUSDC API). */
  amount: string;
  /** USDC ERC-20 contract address on this chain. */
  asset: Address;
  /** Server-issued nonce; client echoes it back in X-PAYMENT-PROOF. */
  nonce: string;
  /** When the challenge expires (unix ms). */
  expiresAt: number;
  /** Path the payment unlocks (so a tx for /a can't unlock /b). */
  resource: string;
}

export interface PaymentProof {
  /** The on-chain USDC transfer tx hash the client just submitted. */
  txHash: Hex;
  /** Echoed nonce from the challenge. */
  nonce: string;
  /** Address that signed/sent the tx. Server verifies tx.from matches. */
  payer: Address;
}

/** Internal record of an unused challenge. */
interface OutstandingChallenge {
  challenge: PaymentChallenge;
  /** Stored as base units (bigint) for the on-chain comparison. */
  amountBaseUnits: bigint;
}

export interface VerificationResult {
  ok: boolean;
  reason?: string;
  /** Populated on success — useful for the server to log. */
  txHash?: Hex;
  payer?: Address;
}

export interface PaymentServerOptions {
  /** Receiving address — every challenge will demand payment here. */
  recipient: Address;
  /** USDC amount per request, as a decimal string ("0.01"). */
  pricePerRequest: string;
  /** Override the RPC if you're not on Arc testnet. */
  rpcUrl?: string;
  /** Challenge TTL; default 5 minutes. */
  challengeTtlMs?: number;
}

/**
 * In-memory payment server: issues challenges, verifies proofs against the
 * live chain, refuses replays. Stateless across restarts by design — wire
 * it up to Redis/Postgres for prod, but for a demo this is enough to prove
 * the flow closes.
 */
export class ArcPaymentServer {
  private readonly recipient: Address;
  private readonly priceDecimal: string;
  private readonly priceBaseUnits: bigint;
  private readonly pub: PublicClient;
  private readonly ttlMs: number;
  /** nonce → challenge mapping. Removed once verified or expired. */
  private readonly outstanding = new Map<string, OutstandingChallenge>();
  /** Set of consumed (nonce, txHash) pairs to block replay. */
  private readonly consumed = new Set<string>();

  constructor(opts: PaymentServerOptions) {
    this.recipient = opts.recipient;
    this.priceDecimal = opts.pricePerRequest;
    this.priceBaseUnits = parseUnits(opts.pricePerRequest, ARC_NATIVE_DECIMALS);
    this.ttlMs = opts.challengeTtlMs ?? 5 * 60 * 1000;
    this.pub = createPublicClient({
      chain: arcTestnet,
      transport: http(opts.rpcUrl ?? ARC_TESTNET_RPC),
    });
  }

  /** Build a fresh 402 challenge for a given resource path. */
  challenge(resource: string): PaymentChallenge {
    const nonce = this.randomNonce();
    const challenge: PaymentChallenge = {
      scheme: "arc-proof-of-payment",
      network: `eip155:${ARC_TESTNET_CHAIN_ID}`,
      recipient: this.recipient,
      amount: this.priceDecimal,
      asset: USDC_ADDRESS,
      nonce,
      expiresAt: Date.now() + this.ttlMs,
      resource,
    };
    this.outstanding.set(nonce, {
      challenge,
      amountBaseUnits: this.priceBaseUnits,
    });
    return challenge;
  }

  /**
   * Verify a client's X-PAYMENT-PROOF header against the chain.
   *
   * Checks performed:
   *   1. nonce matches a still-valid (not expired, not consumed) challenge
   *    2. tx exists, is successful, and is on Arc
   *   3. tx.from === payer (the client claimed they paid)
   *   4. exactly one ERC-20 Transfer log on USDC_ADDRESS, recipient is us,
   *      value >= demanded amount
   *   5. (nonce, txHash) pair hasn't already been consumed
   *
   * On success, the challenge is removed and the pair is marked consumed.
   */
  async verify(
    proof: PaymentProof,
    resource: string,
  ): Promise<VerificationResult> {
    const record = this.outstanding.get(proof.nonce);
    if (!record) {
      return { ok: false, reason: "unknown or already-used nonce" };
    }
    if (record.challenge.expiresAt < Date.now()) {
      this.outstanding.delete(proof.nonce);
      return { ok: false, reason: "challenge expired" };
    }
    if (record.challenge.resource !== resource) {
      return { ok: false, reason: "nonce was issued for a different resource" };
    }

    const replayKey = `${proof.nonce}:${proof.txHash.toLowerCase()}`;
    if (this.consumed.has(replayKey)) {
      return { ok: false, reason: "replay detected" };
    }

    let receipt;
    let tx;
    try {
      [receipt, tx] = await Promise.all([
        this.pub.getTransactionReceipt({ hash: proof.txHash }),
        this.pub.getTransaction({ hash: proof.txHash }),
      ]);
    } catch {
      return { ok: false, reason: "tx not found on chain" };
    }
    if (receipt.status !== "success") {
      return { ok: false, reason: "tx reverted on chain" };
    }
    if (receipt.from.toLowerCase() !== proof.payer.toLowerCase()) {
      return { ok: false, reason: "tx.from does not match claimed payer" };
    }

    // On Arc, USDC is the native gas token, so the canonical payment path
    // is a plain native transfer (tx.to === recipient, tx.value >= amount).
    // We also fall back to ERC-20 Transfer logs in case a future caller
    // pays via the USDC contract's transfer() function instead.
    const recipientLower = this.recipient.toLowerCase();
    const nativeMatch =
      tx.to !== null &&
      tx.to.toLowerCase() === recipientLower &&
      tx.value >= record.amountBaseUnits;

    if (!nativeMatch) {
      const transferLog = findUSDCTransferToRecipient(receipt.logs, this.recipient);
      if (!transferLog) {
        return { ok: false, reason: "no USDC transfer to recipient in tx" };
      }
      if (transferLog.value < record.amountBaseUnits) {
        return {
          ok: false,
          reason: `paid ${transferLog.value} base units, expected at least ${record.amountBaseUnits}`,
        };
      }
    }

    this.outstanding.delete(proof.nonce);
    this.consumed.add(replayKey);
    return { ok: true, txHash: proof.txHash, payer: proof.payer };
  }

  /** Encode a challenge as the 402 response body the client will parse. */
  static encodeChallenge(c: PaymentChallenge): string {
    return JSON.stringify(c);
  }

  /** Parse the value of an X-PAYMENT-PROOF header (base64 JSON). */
  static decodeProofHeader(headerValue: string): PaymentProof | null {
    try {
      const decoded = Buffer.from(headerValue, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as Partial<PaymentProof>;
      if (
        typeof parsed.txHash === "string" &&
        parsed.txHash.startsWith("0x") &&
        typeof parsed.nonce === "string" &&
        typeof parsed.payer === "string" &&
        parsed.payer.startsWith("0x")
      ) {
        return parsed as PaymentProof;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Encode a PaymentProof as a header value (base64 JSON). */
  static encodeProofHeader(proof: PaymentProof): string {
    return Buffer.from(JSON.stringify(proof), "utf8").toString("base64");
  }

  private randomNonce(): string {
    // 16 random bytes hex — enough entropy, no collision risk in practice.
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

/**
 * Walk a tx's logs and find the USDC ERC-20 Transfer with `to === recipient`.
 * Returns the raw value (base units) if found, null otherwise.
 *
 * Decoded manually rather than via decodeEventLog so the function stays
 * cheap and a malformed log doesn't throw the whole verification path.
 */
function findUSDCTransferToRecipient(
  logs: readonly Log[],
  recipient: Address,
): { value: bigint } | null {
  const transferTopic =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const recipientLower = recipient.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    if (log.topics[0] !== transferTopic) continue;
    if (!log.topics[2]) continue;
    // topics[2] is the indexed `to` — left-padded to 32 bytes.
    const to = `0x${log.topics[2].slice(26)}`.toLowerCase();
    if (to !== recipientLower) continue;
    try {
      const value = BigInt(log.data);
      return { value };
    } catch {
      continue;
    }
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Client side                                                              */
/* ──────────────────────────────────────────────────────────────────────── */

export interface PaidFetchOptions {
  wallet: WalletClient;
  /** Optional override for the public client used to wait for confirmation. */
  pub?: PublicClient;
  /**
   * Hard cap on USDC the client is willing to spend in a single call.
   * Defends against a hostile server demanding an absurd price.
   */
  maxAmount?: string;
}

/**
 * Parse a 402 challenge response, decide whether to pay, send the on-chain
 * USDC transfer, then retry the request with X-PAYMENT-PROOF set. Returns
 * the final Response (whatever the server returned after verification).
 *
 * Throws if:
 *   - the response wasn't 402 or wasn't a recognizable challenge
 *   - the challenge demands more than maxAmount
 *   - the on-chain transfer reverts
 */
export async function payChallenge(
  challengeResponse: Response,
  originalUrl: string,
  originalInit: RequestInit | undefined,
  opts: PaidFetchOptions,
): Promise<Response> {
  if (challengeResponse.status !== 402) {
    throw new Error(
      `expected HTTP 402 to pay a challenge, got ${challengeResponse.status}`,
    );
  }
  const challenge = (await challengeResponse.json()) as PaymentChallenge;
  if (challenge.scheme !== "arc-proof-of-payment") {
    throw new Error(`unsupported payment scheme: ${challenge.scheme}`);
  }
  if (challenge.network !== `eip155:${ARC_TESTNET_CHAIN_ID}`) {
    throw new Error(
      `challenge is for ${challenge.network}, this client is wired to Arc testnet only`,
    );
  }
  if (opts.maxAmount !== undefined) {
    const ask = parseUnits(challenge.amount, ARC_NATIVE_DECIMALS);
    const cap = parseUnits(opts.maxAmount, ARC_NATIVE_DECIMALS);
    if (ask > cap) {
      throw new Error(
        `server demanded ${challenge.amount} USDC, exceeds local cap of ${opts.maxAmount}`,
      );
    }
  }

  const payer = opts.wallet.account?.address;
  if (!payer) {
    throw new Error("wallet has no account — pass a walletClient built with a private key");
  }

  // Pay on-chain. sendUSDC returns once the tx is submitted, not mined —
  // we wait for inclusion ourselves so the server's verify() call finds
  // a receipt instead of racing the RPC.
  const { hash } = await sendUSDC(opts.wallet, challenge.recipient, challenge.amount);
  const pub =
    opts.pub ??
    createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
  await pub.waitForTransactionReceipt({ hash });

  const proof: PaymentProof = { txHash: hash, nonce: challenge.nonce, payer };
  const headerValue = ArcPaymentServer.encodeProofHeader(proof);

  const headers = new Headers(originalInit?.headers ?? {});
  headers.set("X-PAYMENT-PROOF", headerValue);

  return fetch(originalUrl, { ...originalInit, headers });
}

/**
 * Like `fetch`, but transparently pays for a 402 response and retries.
 * Convenience wrapper around `payChallenge` for one-shot calls.
 */
export async function paidFetch(
  url: string,
  init: RequestInit | undefined,
  opts: PaidFetchOptions,
): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  return payChallenge(first, url, init, opts);
}
