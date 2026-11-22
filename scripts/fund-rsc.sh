#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. ./.env
set +a
VALUE="${1:-0.05ether}"
echo "before: $(cast balance "$SAPU_RSC_ADDRESS" --rpc-url "$REACTIVE_RPC_URL" --ether) lREACT"
cast send "$SAPU_RSC_ADDRESS" --value "$VALUE" \
  --rpc-url "$REACTIVE_RPC_URL" --private-key "$REACTIVE_PRIVATE_KEY" --priority-gas-price 1 >/dev/null
echo "after:  $(cast balance "$SAPU_RSC_ADDRESS" --rpc-url "$REACTIVE_RPC_URL" --ether) lREACT"
