#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
pattern='placeholder|fixture|dummy|seeded|sample data'
if grep -rniE "$pattern" app/src; then
  echo "AUDIT GREP: matches found (FAIL)"
  exit 1
fi
echo "AUDIT GREP: clean (0 matches)"
