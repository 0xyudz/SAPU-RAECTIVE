#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. ./.env
set +a
cast send "$SAPU_RSC_ADDRESS" "setCallbackGasLimit(uint64)" "${1:-400000}" \
  --rpc-url "$REACTIVE_RPC_URL" --private-key "$REACTIVE_PRIVATE_KEY" --priority-gas-price 1
cast call "$SAPU_RSC_ADDRESS" "callbackGasLimit()(uint64)" --rpc-url "$REACTIVE_RPC_URL"
