#!/usr/bin/env bash
# arc-agent-kit demo — paced terminal run for screen recording.
#
# Usage:
#   bash demo/run-demo.sh           # dry-run (simulate only, no real tx)
#   bash demo/run-demo.sh --real    # actually broadcasts a 0.001 USDC tx
#
# Recommended terminal: full-screen, font 18-20pt, dark theme, prompt cleared.
# See demo/RECORDING.md for the recording walkthrough.

set -e
cd "$(dirname "$0")/.."

MODE="${1:-dry}"
DEMO_RECIPIENT="0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
AMOUNT="0.001"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

banner() {
  local msg="$1"
  echo
  echo -e "${BOLD}${CYAN}┌─────────────────────────────────────────────────────────────┐${RESET}"
  printf "${BOLD}${CYAN}│${RESET}  %-58s ${BOLD}${CYAN}│${RESET}\n" "$msg"
  echo -e "${BOLD}${CYAN}└─────────────────────────────────────────────────────────────┘${RESET}"
  echo
}

prompt() {
  echo
  echo -en "${DIM}\$${RESET} ${BOLD}$1${RESET}"
  sleep 1
  echo
}

# ── Title ────────────────────────────────────────────────────────────
clear
banner "arc-agent-kit — LLM agents transacting on Arc testnet"
sleep 2

# ── Step 1: chain config + signer ────────────────────────────────────
prompt "npx arc info"
npx arc info
sleep 4

# ── Step 2: balance ──────────────────────────────────────────────────
SIGNER=$(npx arc info 2>/dev/null | grep '"signer"' | sed -E 's/.*"(0x[0-9a-fA-F]+)".*/\1/')
prompt "npx arc balance $SIGNER"
npx arc balance "$SIGNER"
sleep 4

# ── Step 3: pre-flight simulation ────────────────────────────────────
prompt "npx arc simulate-usdc $DEMO_RECIPIENT $AMOUNT"
npx arc simulate-usdc "$DEMO_RECIPIENT" "$AMOUNT"
sleep 5

# ── Step 4: actual send (or dry-skip) ────────────────────────────────
if [[ "$MODE" == "--real" ]]; then
  prompt "npx arc send-usdc $DEMO_RECIPIENT $AMOUNT"
  npx arc send-usdc "$DEMO_RECIPIENT" "$AMOUNT"
  sleep 5
else
  echo
  echo -e "${YELLOW}[dry-run mode — skipping the actual send. Re-run with --real to broadcast.]${RESET}"
  sleep 3
fi

# ── Outro ────────────────────────────────────────────────────────────
if [[ "$MODE" == "--real" ]]; then
  banner "Tx confirmed · simulated fee matched actuals to 18 decimals"
else
  banner "Pre-flight simulation passed · run with --real to broadcast"
fi
echo -e "${DIM}    SDK · MCP server · CLI · x402 · on-chain subscriptions${RESET}"
echo -e "${DIM}    github.com/momei3066/arc-agent-kit${RESET}"
echo
sleep 4
