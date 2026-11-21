#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/contracts/lib"

FORGE_STD_REF="v1.17.0"
REACTIVE_REF="3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8"
OPENZEPPELIN_REF="c64a1ed"

say()  { printf '%s\n' "$*"; }
fail() { printf '\nERROR %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is not on PATH."

mkdir -p "$LIB"

fetch() {
  local name="$1" url="$2" ref="$3"
  local dest="$LIB/$name"

  if [ -d "$dest" ] && [ -f "$dest/.sapu-pinned" ]; then
    local current
    current="$(cat "$dest/.sapu-pinned")"
    if [ "$current" = "$ref" ]; then
      say "  $name already at $ref — skipping"
      return 0
    fi
    say "  $name at $current, want $ref — refetching"
    rm -rf "$dest"
  elif [ -d "$dest" ]; then
    say "  $name exists but is not pinned — leaving it alone"
    say "  (delete $dest and re-run to pin it to $ref)"
    return 0
  fi

  say "  fetching $name @ $ref"
  local tmp
  tmp="$(mktemp -d)"
  git clone --quiet --depth 1 --branch "$ref" "$url" "$tmp/$name" 2>/dev/null \
    || git clone --quiet "$url" "$tmp/$name"
  if [ -d "$tmp/$name/.git" ]; then
    git -C "$tmp/$name" checkout --quiet "$ref" 2>/dev/null || true
  fi
  rm -rf "$tmp/$name/.git"
  printf '%s\n' "$ref" > "$tmp/$name/.sapu-pinned"
  mv "$tmp/$name" "$dest"
  rm -rf "$tmp"
}

say "SAPU :: fetching pinned Solidity dependencies into contracts/lib"
say ""

fetch "forge-std" \
      "https://github.com/foundry-rs/forge-std" \
      "$FORGE_STD_REF"

fetch "reactive" \
      "https://github.com/Reactive-Network/reactive-lib-omni" \
      "$REACTIVE_REF"

fetch "openzeppelin-contracts" \
      "https://github.com/OpenZeppelin/openzeppelin-contracts" \
      "$OPENZEPPELIN_REF"

say ""
say "Done. Verify with:"
say "  cd contracts && forge test"
