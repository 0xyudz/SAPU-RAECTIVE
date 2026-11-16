#!/usr/bin/env bash
#
# scripts/e2e-demo.sh
#
# The whole SAPU loop, end to end, against live testnets. One command:
#
#   bash scripts/e2e-demo.sh
#
# What it does:
#
#   1. Sends ERC-20 tokens to a burner that holds zero ETH and zero tokens. (Tx1)
#   2. Waits. Nobody funds the burner. Nobody signs anything from it.
#   3. The Reactive Smart Contract sees the Transfer log on Base Sepolia and
#      requests a callback on Reactive Lasna.                            (Tx2)
#   4. SapuForwarder executes the sweep, moving the tokens to the cold
#      wallet.                                                            (Tx3)
#   5. Reads all three legs back out of raw chain logs, verifies them
#      independently, and prints the measured tx1 -> tx3 latency.
#
# This script makes no claim about how fast the loop is. It measures the latency
# from real block timestamps and prints the number it observed. If the loop does
# not close it exits non-zero and names the leg that is missing — it never
# invents a hash.
#
# Usage:
#   bash scripts/e2e-demo.sh
#   bash scripts/e2e-demo.sh --amount 2.5
#   bash scripts/e2e-demo.sh --burner 0x... --token 0x...
#   bash scripts/e2e-demo.sh --timeout 180
#   bash scripts/e2e-demo.sh --help
#
# Configuration comes from .env at the repository root (see .env.example), or
# from the ambient environment, which takes precedence:
#
#   BASE_SEPOLIA_RPC_URL      required
#   REACTIVE_RPC_URL          required
#   DEPLOYER_PRIVATE_KEY      required — wallet sending the deposit (holds tokens)
#   SAPU_TOKEN_ADDRESS        required — ERC-20 to deposit
#   SAPU_BURNER_ADDRESS       required — the burner to fill (must be an armed route)
#   SAPU_FORWARDER_ADDRESS    required — SapuForwarder, for the Tx3 log query
#
# Set KEEP_LOGS=1 to retain the raw child-process output.

set -euo pipefail

# ---------------------------------------------------------------------------
# Location + presentation
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_LIME=$'\033[38;5;154m'
  C_RED=$'\033[31m'
  C_STEEL=$'\033[38;5;245m'
else
  C_RESET=''
  C_DIM=''
  C_LIME=''
  C_RED=''
  C_STEEL=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$C_LIME" "$C_RESET" "$*"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
fail() { printf '\n%sERROR%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
SAPU :: end-to-end loop demo

Sends ERC-20 tokens into an empty burner on Base Sepolia, then verifies from raw
chain logs that the Reactive Smart Contract requested a callback (Reactive Lasna)
and that SapuForwarder swept the tokens to the cold wallet. Prints the measured
tx1 -> tx3 latency.

Usage:
  bash scripts/e2e-demo.sh [options]

Options:
  --amount <n>      Token amount to deposit (default: 1)
  --burner <addr>   Burner to fill, overriding SAPU_BURNER_ADDRESS
  --token <addr>    ERC-20 to deposit, overriding SAPU_TOKEN_ADDRESS
  --timeout <secs>  How long to wait for Tx3 (default: 120)
  -h, --help        Show this help

Environment:
  Reads .env at the repository root. Ambient variables take precedence.
  Required: BASE_SEPOLIA_RPC_URL, REACTIVE_RPC_URL, DEPLOYER_PRIVATE_KEY,
            SAPU_TOKEN_ADDRESS, SAPU_BURNER_ADDRESS, SAPU_FORWARDER_ADDRESS

  KEEP_LOGS=1       Keep the raw child-process logs instead of discarding them.
  NO_COLOR=1        Disable ANSI colour.
USAGE
  exit 0
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

AMOUNT=""
BURNER=""
TOKEN=""
TIMEOUT="120"

while [ $# -gt 0 ]; do
  case "$1" in
    --amount)  AMOUNT="${2:-}";  shift 2 ;;
    --burner)  BURNER="${2:-}";  shift 2 ;;
    --token)   TOKEN="${2:-}";   shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# .env loading
#
# Deliberately not `source .env`: a value containing spaces or shell
# metacharacters would be executed. This parses KEY=VALUE only, strips one layer
# of matching quotes, and never overrides a variable that is already set.
# ---------------------------------------------------------------------------

load_dotenv() {
  [ -f .env ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Trim leading/trailing whitespace from the key.
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    case "$key" in
      ''|*[!A-Za-z0-9_]*) continue ;;
    esac
    # Strip an optional `export ` prefix that survived the split.
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    # Trim trailing CR (files authored on Windows) and surrounding whitespace.
    value="$(printf '%s' "$value" | tr -d '\r')"
    if [ -z "$(eval "printf '%s' \"\${$key:-}\"")" ]; then
      export "$key=$value"
    fi
  done < .env
}

load_dotenv

# ---------------------------------------------------------------------------
# Toolchain
# ---------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || fail "node is not on PATH. Node >= 20.9 is required."

if [ -x "node_modules/.bin/tsx" ]; then
  TSX="node_modules/.bin/tsx"
elif [ -x "node_modules/.bin/tsx.cmd" ]; then
  TSX="node_modules/.bin/tsx.cmd"
elif command -v npx >/dev/null 2>&1; then
  TSX="npx --yes tsx"
else
  fail "tsx is not installed. Run: npm install"
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

step "Preflight"

TOKEN="${TOKEN:-${SAPU_TOKEN_ADDRESS:-}}"
BURNER="${BURNER:-${SAPU_BURNER_ADDRESS:-}}"

missing=""
need() {
  # need <variable-name> <resolved-value>
  if [ -z "$2" ]; then missing="$missing  - $1
"; fi
}
need "BASE_SEPOLIA_RPC_URL"        "${BASE_SEPOLIA_RPC_URL:-}"
need "REACTIVE_RPC_URL"            "${REACTIVE_RPC_URL:-}"
need "DEPLOYER_PRIVATE_KEY"        "${DEPLOYER_PRIVATE_KEY:-}"
need "SAPU_TOKEN_ADDRESS"          "$TOKEN"
need "SAPU_BURNER_ADDRESS"         "$BURNER"
need "SAPU_FORWARDER_ADDRESS"      "${SAPU_FORWARDER_ADDRESS:-}"

if [ -n "$missing" ]; then
  say ""
  say "Missing configuration:"
  printf '%s' "$missing"
  say ""
  say "Copy .env.example to .env and fill it in, or export the variables directly."
  say "The full deployment sequence is in README.md."
  exit 1
fi

# The TypeScript children read .env themselves via dotenv, but explicit flags
# keep the two processes guaranteed-consistent with what is printed above.
export SAPU_TOKEN_ADDRESS="$TOKEN"
export SAPU_BURNER_ADDRESS="$BURNER"

LOG_DIR="$(mktemp -d 2>/dev/null || echo ".sapu-e2e-$$")"
mkdir -p "$LOG_DIR"
DEPOSIT_LOG="$LOG_DIR/tx1.log"
VERIFY_LOG="$LOG_DIR/verify.log"

cleanup() {
  if [ "${KEEP_LOGS:-0}" = "1" ]; then
    dim "logs kept in $LOG_DIR"
  else
    rm -rf "$LOG_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

say ""
say "${C_LIME}SAPU${C_RESET} :: Silent Automated Purge Unit"
say "${C_STEEL}Fund a burner wallet. It empties itself before anyone can watch it fill.${C_RESET}"
say ""
say "  token      $TOKEN"
say "  burner     $BURNER"
say "  forwarder  $SAPU_FORWARDER_ADDRESS"
say "  amount     ${AMOUNT:-1}"
say "  timeout    ${TIMEOUT}s for Tx3"

# ---------------------------------------------------------------------------
# Tx1 — the deposit
# ---------------------------------------------------------------------------

step "Tx1 — sending tokens into the burner"

set +e
if [ -n "$AMOUNT" ]; then
  "$TSX" scripts/trigger-deposit.ts --amount "$AMOUNT" --token "$TOKEN" --burner "$BURNER" 2>&1 | tee "$DEPOSIT_LOG"
else
  "$TSX" scripts/trigger-deposit.ts --token "$TOKEN" --burner "$BURNER" 2>&1 | tee "$DEPOSIT_LOG"
fi
DEPOSIT_STATUS=${PIPESTATUS[0]}
set -e

[ "$DEPOSIT_STATUS" -eq 0 ] || fail "Tx1 failed. No deposit landed, so there is nothing to sweep."

TX1_HASH="$(grep -oE 'tx1 sent +0x[0-9a-fA-F]{64}' "$DEPOSIT_LOG" | grep -oE '0x[0-9a-fA-F]{64}' | head -n1 || true)"
TX1_BLOCK="$(grep -oE 'tx1 mined +block [0-9]+' "$DEPOSIT_LOG" | grep -oE '[0-9]+' | head -n1 || true)"

[ -n "$TX1_HASH" ]  || fail "could not read the Tx1 hash from the deposit output (set KEEP_LOGS=1 and re-run)"
[ -n "$TX1_BLOCK" ] || fail "could not read the Tx1 block from the deposit output (set KEEP_LOGS=1 and re-run)"

say ""
dim "Tx1 is done. The operator's job is over: no gas was sent to the burner,"
dim "and no transaction will ever be signed by the burner."

# ---------------------------------------------------------------------------
# Tx2 + Tx3 — the loop closes on its own
# ---------------------------------------------------------------------------

step "Tx2/Tx3 — waiting for the reactive callback and the sweep"

say ""
dim "Polling Base Sepolia and Reactive Lasna. This is the autonomous part:"
dim "nothing below is triggered by this script."

set +e
"$TSX" scripts/verify-sweep.ts --from-block "$TX1_BLOCK" --timeout "$TIMEOUT" 2>&1 | tee "$VERIFY_LOG"
VERIFY_STATUS=${PIPESTATUS[0]}
set -e

LATENCY="$(grep -oE 'latency +[0-9]+s' "$VERIFY_LOG" | grep -oE '[0-9]+' | head -n1 || true)"
RESULT="$(grep -oE 'result +.*' "$VERIFY_LOG" | sed 's/^result *//' || true)"
TX2_HASH="$(grep -oE 'lasna\.reactscan\.net/tx/0x[0-9a-fA-F]{64}' "$VERIFY_LOG" | grep -oE '0x[0-9a-fA-F]{64}' | head -n1 || true)"
TX3_HASH="$(grep -oE 'sepolia\.basescan\.org/tx/0x[0-9a-fA-F]{64}' "$VERIFY_LOG" | grep -oE '0x[0-9a-fA-F]{64}' | tail -n1 || true)"

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------

if [ "$VERIFY_STATUS" -ne 0 ] || [ "$RESULT" != "LOOP VERIFIED" ]; then
  say ""
  say "${C_RED}LOOP INCOMPLETE${C_RESET} — Tx3 was not observed within ${TIMEOUT}s."
  say ""
  say "  Tx1  deposit    https://sepolia.basescan.org/tx/$TX1_HASH"
  if [ -n "$TX2_HASH" ]; then
    say "  Tx2  callback   https://lasna.reactscan.net/tx/$TX2_HASH"
  else
    say "  Tx2  callback   not seen — the RSC did not request a callback."
    say "                  Check the route is armed on both sides, and that the RSC"
    say "                  holds lREACT to pay for reactive transactions."
  fi
  say "  Tx3  sweep      not seen"
  say ""
  say "Diagnostics: docs/LIMITATIONS.md §4 (\"Failure modes\")."
  say "Re-run with KEEP_LOGS=1 to retain the raw output."
  exit 1
fi

say ""
say "${C_LIME}┌──────────────────────────────────────────────────────────────┐${C_RESET}"
say "${C_LIME}│  LOOP CLOSED — the burner is empty again.                     │${C_RESET}"
say "${C_LIME}└──────────────────────────────────────────────────────────────┘${C_RESET}"
say ""
say "  Tx1  deposit    https://sepolia.basescan.org/tx/$TX1_HASH"
if [ -n "$TX2_HASH" ]; then
  say "  Tx2  callback   https://lasna.reactscan.net/tx/$TX2_HASH"
else
  say "  Tx2  callback   verified (hash not parsed; see logs)"
fi
if [ -n "$TX3_HASH" ] && [ "$TX3_HASH" != "$TX1_HASH" ]; then
  say "  Tx3  sweep      https://sepolia.basescan.org/tx/$TX3_HASH"
else
  say "  Tx3  sweep      verified (hash not parsed; see logs)"
fi
say ""
if [ -n "$LATENCY" ]; then
  say "  ${C_LIME}measured tx1 → tx3 latency: ${LATENCY}s${C_RESET}"
  dim "  (computed from real Base Sepolia block timestamps, not a constant)"
else
  dim "  latency not reported by the verifier"
fi
say ""
dim "  The burner never held ETH and never sent a transaction."
dim "  Re-verify at any time: npm run verify-sweep -- --from-block $TX1_BLOCK"
say ""
