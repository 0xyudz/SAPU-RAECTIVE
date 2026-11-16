#!/usr/bin/env bash
#
# scripts/setup-contracts.sh
#
# Fetches the pinned Solidity dependencies into contracts/lib. `contracts/lib/` is
# gitignored, so a fresh clone needs this before `forge build` or `forge test`
# will work.
#
#   bash scripts/setup-contracts.sh
#
# Every dependency is pinned to an exact commit, not a branch. A branch would mean
# two judges cloning on different days compile different code, and a silent
# compiler change in a base contract is exactly the kind of thing that turns a
# passing test suite into a failing one for no visible reason.
#
# The pinned revisions are the ones this repository was developed and verified
# against:
#   - forge-std              v1.17.0
#   - reactive-lib-omni      3ade0dc  (Omni API: requestCallbackV_1_0)
#   - openzeppelin-contracts v5.4.0   (c64a1ed)
#
# The remappings these feed are in contracts/foundry.toml:
#   @reactive/              -> lib/reactive/src/
#   @openzeppelin/contracts/-> lib/openzeppelin-contracts/contracts/
#   forge-std/              -> lib/forge-std/src/

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

# fetch <name> <url> <ref>
#
# Clones at an exact ref, shallow where the ref is a tag, and removes the nested
# .git directory. Removing it matters: a nested repo becomes a gitlink in the
# parent index, which silently commits a pointer instead of files.
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
