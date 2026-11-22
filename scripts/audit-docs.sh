#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
grep -rniE 'pending|not verified|no verified|requires funded|not been run' README.md docs/*.md || echo "no stale pending claims"
