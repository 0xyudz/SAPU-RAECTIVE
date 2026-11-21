#!/usr/bin/env bash

set -euo pipefail

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

Deploys or reuses contracts, arms a burner route, deposits ERC-20 tokens into the
empty burner on Base Sepolia, waits for Tx2 (Reactive Lasna) and Tx3 (Base Sepolia),
and writes docs/proof/latest.json. Fails loudly if Tx3 does not land within 60s.

Usage:
  bash scripts/e2e-demo.sh [options]

Options:
  --amount <n>      Token amount to deposit (default: 1)
  --burner <addr>   Burner to fill, overriding SAPU_BURNER_ADDRESS
  --token <addr>    ERC-20 to deposit, overriding SAPU_TOKEN_ADDRESS
  --timeout <secs>  How long to wait for Tx3 (default: 60)
  -h, --help        Show this help
USAGE
  exit 0
}

AMOUNT=""
BURNER=""
TOKEN=""
TIMEOUT="60"

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

load_dotenv_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    local key="${line%%=*}"
    local value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    case "$key" in
      ''|*[!A-Za-z0-9_]*) continue ;;
    esac
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    value="$(printf '%s' "$value" | tr -d '\r')"
    if [ -z "$(eval "printf '%s' \"\${$key:-}\"")" ]; then
      export "$key=$value"
    fi
  done < "$file"
}

load_dotenv_file ".env"
load_dotenv_file "app/.env.local"

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

export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export REACTIVE_RPC_URL="${REACTIVE_RPC_URL:-https://lasna-rpc.rnk.dev/}"

[ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || fail "DEPLOYER_PRIVATE_KEY is required in env or .env"
[ -n "${REACTIVE_PRIVATE_KEY:-}" ] || fail "REACTIVE_PRIVATE_KEY is required in env or .env"

LOG_DIR="$(mktemp -d 2>/dev/null || echo ".sapu-e2e-$$")"
mkdir -p "$LOG_DIR"
ARM_JSON="$LOG_DIR/arm.json"
DEPOSIT_LOG="$LOG_DIR/tx1.log"
VERIFY_JSON="$LOG_DIR/verify.json"

cleanup() {
  if [ "${KEEP_LOGS:-0}" = "1" ]; then
    dim "logs kept in $LOG_DIR"
  else
    rm -rf "$LOG_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step "1. Deploy or reuse contracts"

if [ -n "${NEXT_PUBLIC_SAPU_RSC_ADDRESS:-}" ] && [ -z "${SAPU_RSC_ADDRESS:-}" ]; then
  export SAPU_RSC_ADDRESS="$NEXT_PUBLIC_SAPU_RSC_ADDRESS"
fi
if [ -n "${NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS:-}" ] && [ -z "${SAPU_FORWARDER_ADDRESS:-}" ]; then
  export SAPU_FORWARDER_ADDRESS="$NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS"
fi
if [ -n "${TOKEN:-}" ]; then
  export SAPU_TOKEN_ADDRESS="$TOKEN"
elif [ -n "${NEXT_PUBLIC_SAPU_TOKEN_ADDRESS:-}" ] && [ -z "${SAPU_TOKEN_ADDRESS:-}" ]; then
  export SAPU_TOKEN_ADDRESS="$NEXT_PUBLIC_SAPU_TOKEN_ADDRESS"
fi

if ! "$TSX" scripts/verify-live.ts >/dev/null 2>&1; then
  bash scripts/deploy-live.sh
  load_dotenv_file "app/.env.local"
  export SAPU_RSC_ADDRESS="${SAPU_RSC_ADDRESS:-${NEXT_PUBLIC_SAPU_RSC_ADDRESS:-}}"
  export SAPU_FORWARDER_ADDRESS="${SAPU_FORWARDER_ADDRESS:-${NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS:-}}"
  export SAPU_TOKEN_ADDRESS="${SAPU_TOKEN_ADDRESS:-${NEXT_PUBLIC_SAPU_TOKEN_ADDRESS:-}}"
fi

"$TSX" scripts/verify-live.ts

TOKEN="${TOKEN:-${SAPU_TOKEN_ADDRESS:-${NEXT_PUBLIC_SAPU_TOKEN_ADDRESS:-}}}"
export SAPU_TOKEN_ADDRESS="$TOKEN"
[ -n "$BURNER" ] && export SAPU_BURNER_ADDRESS="$BURNER"

step "2. Arm route (setForwarder + registerRoute + EIP-2612 armWithPermit + armRoute)"

if [ -n "$AMOUNT" ]; then
  "$TSX" scripts/arm-route.ts --out "$ARM_JSON" --amount "$AMOUNT"
else
  "$TSX" scripts/arm-route.ts --out "$ARM_JSON"
fi

BURNER="$(node -e "const d = JSON.parse(require('fs').readFileSync('$ARM_JSON','utf8')); console.log(d.burner);")"
export SAPU_BURNER_ADDRESS="$BURNER"

say ""
say "${C_LIME}SAPU${C_RESET} :: Silent Automated Purge Unit"
say "  token      $TOKEN"
say "  burner     $BURNER"
say "  forwarder  $SAPU_FORWARDER_ADDRESS"
say "  amount     ${AMOUNT:-1}"
say "  timeout    ${TIMEOUT}s for Tx3"

step "3. Tx1 — sending tokens into the empty burner"

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

[ -n "$TX1_HASH" ]  || fail "could not read the Tx1 hash from deposit output"
[ -n "$TX1_BLOCK" ] || fail "could not read the Tx1 block from deposit output"

step "4. Tx2/Tx3 — waiting up to ${TIMEOUT}s for reactive callback and sweep"

set +e
"$TSX" scripts/verify-sweep.ts --from-block "$TX1_BLOCK" --timeout "$TIMEOUT" --json > "$VERIFY_JSON"
VERIFY_STATUS=$?
set -e

if [ "$VERIFY_STATUS" -ne 0 ]; then
  cat "$VERIFY_JSON" >&2 || true
  fail "LOOP INCOMPLETE — Tx3 did not land within ${TIMEOUT}s (Tx1: https://sepolia.basescan.org/tx/$TX1_HASH)."
fi

step "5. Writing docs/proof/latest.json"

mkdir -p "$REPO_ROOT/docs/proof"
node -e '
const fs = require("fs");
const arm = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const verify = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const tx1 = verify.legs.tx1;
const tx2 = verify.legs.tx2;
const tx3 = verify.legs.tx3;
if (!verify.complete || !tx1.txHash || !tx3.txHash) {
  console.error("Incomplete verification payload.");
  process.exit(1);
}
const armTx = arm.armTx || {
  hash: tx2.txHash,
  chainId: 5318007,
  explorerUrl: "https://lasna.reactscan.net/tx/" + tx2.txHash,
  blockNumber: String(tx2.blockNumber || "0"),
  label: "Reactive callback request",
};
const latencyMs = typeof verify.latencySeconds === "number" ? Math.max(0, verify.latencySeconds * 1000) : 0;
const proof = {
  generatedAt: new Date().toISOString(),
  latencyMs,
  transactions: {
    arm: armTx,
    deposit: {
      hash: tx1.txHash,
      chainId: 84532,
      explorerUrl: "https://sepolia.basescan.org/tx/" + tx1.txHash,
      blockNumber: String(tx1.blockNumber),
      label: "Tx1 deposit to burner",
    },
    sweep: {
      hash: tx3.txHash,
      chainId: 84532,
      explorerUrl: "https://sepolia.basescan.org/tx/" + tx3.txHash,
      blockNumber: String(tx3.blockNumber),
      label: "Tx3 forwarder sweep to cold wallet",
    },
  },
  contracts: {
    rsc: arm.rsc,
    forwarder: arm.forwarder,
    token: arm.token,
  },
};
fs.writeFileSync(process.argv[3], JSON.stringify(proof, null, 2) + "\n");
console.log("Wrote " + process.argv[3]);
console.log("  arm     " + proof.transactions.arm.explorerUrl);
console.log("  deposit " + proof.transactions.deposit.explorerUrl);
console.log("  sweep   " + proof.transactions.sweep.explorerUrl);
console.log("  latency " + proof.latencyMs + " ms");
' "$ARM_JSON" "$VERIFY_JSON" "$REPO_ROOT/docs/proof/latest.json"

say ""
say "${C_LIME}LOOP CLOSED — docs/proof/latest.json updated.${C_RESET}"
