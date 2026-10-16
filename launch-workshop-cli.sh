#!/usr/bin/env bash
# Open a temporary interactive fish child with a "workshop" function that runs
# this checkout's CLI (src/cli/main.ts) through bun. The parent shell is never
# modified: the fish child owns its own globals and cwd, and "exit" simply
# returns to the caller. The dependency check (bun install --frozen-lockfile)
# always runs first; bun itself decides whether anything needs installing.
set -euo pipefail

label=launch-workshop-cli
fail() { printf '%s: error: %s\n' "$label" "$1" >&2; exit 1; }

# Resolve the checkout from this script's own location, following symlinks so a
# symlinked launcher (e.g. ~/bin/workshop) still finds the real checkout.
source=${BASH_SOURCE[0]}
while [[ -L $source ]]; do
  target_dir=$(cd "$(dirname "$source")" && pwd -P)
  source=$(readlink "$source")
  [[ $source == /* ]] || source=$target_dir/$source
done
checkout=$(cd "$(dirname "$source")" && pwd -P)

entry=$checkout/src/cli/main.ts
[[ -f $entry ]] || fail "checkout is incomplete: no src/cli/main.ts under $checkout"

command -v bun >/dev/null 2>&1 || fail "bun is not on PATH — install it from https://bun.sh and retry"
command -v fish >/dev/null 2>&1 || fail "fish is not on PATH — install it from https://fishshell.com and retry"

# Dependency check. Always runs, from the checkout, in a subshell so the
# caller's cwd is preserved for the fish child below. --frozen-lockfile makes
# bun fail instead of updating bun.lock when the lockfile needs changes.
printf '%s: bun install --frozen-lockfile (in %s)\n' "$label" "$checkout"
if ! (cd "$checkout" && bun install --frozen-lockfile); then
  fail "bun install --frozen-lockfile failed in $checkout — not starting the workshop shell"
fi

# Hand the checkout to fish through a temporary env var; no path is ever
# eval'd. The init command copies it into a global workshop_repo variable and
# erases the env var, so nothing leaks to processes started inside the shell.
# Normal fish startup and user configs run untouched; this applies after them.
export WORKSHOP_REPO=$checkout
printf '%s: workshop shell ready — try "workshop --help"; "exit" returns to your shell\n' "$label"
exec fish --init-command '
  set -g workshop_repo "$WORKSHOP_REPO"
  set -e WORKSHOP_REPO
  function workshop
    bun "$workshop_repo/src/cli/main.ts" $argv
  end
'
