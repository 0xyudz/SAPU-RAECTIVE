#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. ./.env
set +a
SYS=0x8888888888888888888888888888888888888888
echo "debt before: $(cast call "$SYS" 'debt(address)(uint256)' "$SAPU_RSC_ADDRESS" --rpc-url "$REACTIVE_RPC_URL")"
cast send "$SAPU_RSC_ADDRESS" "coverDebt()" \
  --rpc-url "$REACTIVE_RPC_URL" --private-key "$REACTIVE_PRIVATE_KEY" --priority-gas-price 1 >/dev/null
echo "debt after:  $(cast call "$SYS" 'debt(address)(uint256)' "$SAPU_RSC_ADDRESS" --rpc-url "$REACTIVE_RPC_URL")"
echo "rsc balance: $(cast balance "$SAPU_RSC_ADDRESS" --rpc-url "$REACTIVE_RPC_URL" --ether)"
