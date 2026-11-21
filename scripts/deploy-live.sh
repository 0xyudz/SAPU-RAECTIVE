#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

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

export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export REACTIVE_RPC_URL="${REACTIVE_RPC_URL:-https://lasna-rpc.rnk.dev/}"

command -v forge >/dev/null 2>&1 || fail "forge is required on PATH."
command -v cast  >/dev/null 2>&1 || fail "cast is required on PATH."

[ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || fail "DEPLOYER_PRIVATE_KEY must be set in env or .env"
[ -n "${REACTIVE_PRIVATE_KEY:-}" ] || fail "REACTIVE_PRIVATE_KEY must be set in env or .env"

has_code() {
  local addr="$1" rpc="$2"
  [ -n "$addr" ] || return 1
  local code
  code="$(cast code "$addr" --rpc-url "$rpc" 2>/dev/null || echo "0x")"
  [ "$code" != "0x" ] && [ "$code" != "0x0" ] && [ -n "$code" ]
}

parse_logged_address() {
  local output="$1" label="$2"
  printf '%s\n' "$output" | awk -v lbl="$label" '$1 == lbl { print $2 }' | tail -n1
}

step "1. Reactive Lasna (5318007) — SapuRSC"

RSC_DEPLOY_BLOCK="${NEXT_PUBLIC_SAPU_RSC_DEPLOY_BLOCK:-}"
if has_code "${SAPU_RSC_ADDRESS:-}" "$REACTIVE_RPC_URL"; then
  say "Reusing existing SapuRSC at $SAPU_RSC_ADDRESS"
else
  [ -d "contracts/lib/reactive" ] || bash scripts/setup-contracts.sh
  RSC_FUND="${SAPU_RSC_FUND_VALUE:-0.05ether}"
  RSC_OUT="$(
    forge script contracts/script/DeployReactiveOmni.s.sol:DeployReactiveOmni \
      --root contracts --rpc-url "$REACTIVE_RPC_URL" --broadcast \
      --private-key "$REACTIVE_PRIVATE_KEY" --value "$RSC_FUND" 2>&1
  )"
  printf '%s\n' "$RSC_OUT"
  SAPU_RSC_ADDRESS="$(parse_logged_address "$RSC_OUT" "SapuRSC")"
  has_code "$SAPU_RSC_ADDRESS" "$REACTIVE_RPC_URL" || fail "Failed to deploy or verify SapuRSC bytecode."
  RSC_DEPLOY_BLOCK="$(cast block-number --rpc-url "$REACTIVE_RPC_URL")"
fi
export SAPU_RSC_ADDRESS

step "2. Base Sepolia (84532) — SweepableERC20 & SapuForwarder"

FORWARDER_DEPLOY_BLOCK="${NEXT_PUBLIC_SAPU_FORWARDER_DEPLOY_BLOCK:-}"
REUSE_FORWARDER=0
if has_code "${SAPU_FORWARDER_ADDRESS:-}" "$BASE_SEPOLIA_RPC_URL"; then
  BOUND_RSC="$(cast call "$SAPU_FORWARDER_ADDRESS" "_CALLBACK_SENDER()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL" 2>/dev/null || echo "")"
  if [ "$(printf '%s' "$BOUND_RSC" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$SAPU_RSC_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]; then
    REUSE_FORWARDER=1
  else
    say "Existing SapuForwarder ($SAPU_FORWARDER_ADDRESS) is bound to $BOUND_RSC != $SAPU_RSC_ADDRESS; deploying a fresh forwarder."
  fi
fi

if [ "$REUSE_FORWARDER" -eq 1 ] && has_code "${SAPU_TOKEN_ADDRESS:-}" "$BASE_SEPOLIA_RPC_URL"; then
  say "Reusing existing SapuForwarder at $SAPU_FORWARDER_ADDRESS and Token at $SAPU_TOKEN_ADDRESS"
else
  [ -d "contracts/lib/openzeppelin-contracts" ] || bash scripts/setup-contracts.sh
  BASE_OUT="$(
    forge script contracts/script/DeployBaseSepolia.s.sol:DeployBaseSepolia \
      --root contracts --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast \
      --private-key "$DEPLOYER_PRIVATE_KEY" 2>&1
  )"
  printf '%s\n' "$BASE_OUT"
  SAPU_FORWARDER_ADDRESS="$(parse_logged_address "$BASE_OUT" "SapuForwarder")"
  SAPU_TOKEN_ADDRESS="$(parse_logged_address "$BASE_OUT" "Token")"
  has_code "$SAPU_FORWARDER_ADDRESS" "$BASE_SEPOLIA_RPC_URL" || fail "Failed to verify SapuForwarder bytecode."
  has_code "$SAPU_TOKEN_ADDRESS" "$BASE_SEPOLIA_RPC_URL" || fail "Failed to verify Token bytecode."
  FORWARDER_DEPLOY_BLOCK="$(cast block-number --rpc-url "$BASE_SEPOLIA_RPC_URL")"
fi
export SAPU_FORWARDER_ADDRESS SAPU_TOKEN_ADDRESS

step "3. Wiring SapuRSC.setForwarder and ensuring SapuForwarder ETH reserve"

CURRENT_FWD="$(cast call "$SAPU_RSC_ADDRESS" "sapuForwarder()(address)" --rpc-url "$REACTIVE_RPC_URL")"
if [ "$(printf '%s' "$CURRENT_FWD" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$SAPU_FORWARDER_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]; then
  say "Setting SapuRSC.sapuForwarder = $SAPU_FORWARDER_ADDRESS"
  cast send "$SAPU_RSC_ADDRESS" "setForwarder(address)" "$SAPU_FORWARDER_ADDRESS" \
    --rpc-url "$REACTIVE_RPC_URL" --private-key "$REACTIVE_PRIVATE_KEY" >/dev/null
else
  say "SapuRSC.sapuForwarder already points to $SAPU_FORWARDER_ADDRESS"
fi

FWD_BAL="$(cast balance "$SAPU_FORWARDER_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL")"
MIN_WEI="5000000000000000"
if [ "$(node -e "console.log(BigInt('$FWD_BAL') < BigInt('$MIN_WEI') ? 1 : 0)")" = "1" ]; then
  say "Funding SapuForwarder with 0.01 ETH for callback execution..."
  cast send "$SAPU_FORWARDER_ADDRESS" --value 0.01ether \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" >/dev/null
else
  say "SapuForwarder balance sufficient (${FWD_BAL} wei)"
fi

TOKEN_SYMBOL="$(cast call "$SAPU_TOKEN_ADDRESS" "symbol()(string)" --rpc-url "$BASE_SEPOLIA_RPC_URL" 2>/dev/null | tr -d '"' || echo "SAPU")"
TOKEN_DECIMALS="$(cast call "$SAPU_TOKEN_ADDRESS" "decimals()(uint8)" --rpc-url "$BASE_SEPOLIA_RPC_URL" 2>/dev/null || echo "18")"
[ -n "$RSC_DEPLOY_BLOCK" ] || RSC_DEPLOY_BLOCK="$(cast block-number --rpc-url "$REACTIVE_RPC_URL")"
[ -n "$FORWARDER_DEPLOY_BLOCK" ] || FORWARDER_DEPLOY_BLOCK="$(cast block-number --rpc-url "$BASE_SEPOLIA_RPC_URL")"

step "4. Writing app/.env.local (public values only)"

cat > "$REPO_ROOT/app/.env.local" <<EOF
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=$BASE_SEPOLIA_RPC_URL
NEXT_PUBLIC_REACTIVE_RPC_URL=$REACTIVE_RPC_URL
NEXT_PUBLIC_SAPU_RSC_ADDRESS=$SAPU_RSC_ADDRESS
NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS=$SAPU_FORWARDER_ADDRESS
NEXT_PUBLIC_SAPU_TOKEN_ADDRESS=$SAPU_TOKEN_ADDRESS
NEXT_PUBLIC_SAPU_TOKEN_SYMBOL=$TOKEN_SYMBOL
NEXT_PUBLIC_SAPU_TOKEN_DECIMALS=$TOKEN_DECIMALS
NEXT_PUBLIC_SAPU_RSC_DEPLOY_BLOCK=$RSC_DEPLOY_BLOCK
NEXT_PUBLIC_SAPU_FORWARDER_DEPLOY_BLOCK=$FORWARDER_DEPLOY_BLOCK
EOF

say ""
say "=== SAPU DEPLOYMENT ADDRESSES (copy-paste into .env) ==="
say "SAPU_RSC_ADDRESS=$SAPU_RSC_ADDRESS"
say "SAPU_FORWARDER_ADDRESS=$SAPU_FORWARDER_ADDRESS"
say "SAPU_TOKEN_ADDRESS=$SAPU_TOKEN_ADDRESS"
say "NEXT_PUBLIC_SAPU_RSC_ADDRESS=$SAPU_RSC_ADDRESS"
say "NEXT_PUBLIC_SAPU_FORWARDER_ADDRESS=$SAPU_FORWARDER_ADDRESS"
say "NEXT_PUBLIC_SAPU_TOKEN_ADDRESS=$SAPU_TOKEN_ADDRESS"
say "NEXT_PUBLIC_SAPU_RSC_DEPLOY_BLOCK=$RSC_DEPLOY_BLOCK"
say "NEXT_PUBLIC_SAPU_FORWARDER_DEPLOY_BLOCK=$FORWARDER_DEPLOY_BLOCK"
say "======================================================="
say "Wrote app/.env.local. Next: npx tsx scripts/verify-live.ts"
