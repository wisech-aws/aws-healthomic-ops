#!/bin/sh
# estimate-run-cost.sh — environment-safe launcher (standalone package).
#
# Verifies the environment BEFORE Node runs, so a user with no Node (or old Node,
# or uninstalled deps) gets actionable guidance instead of a cryptic error:
#   1. Node present?         -> else print how to install Node and exit 127.
#   2. Node >= 20?           -> else print the version problem and exit 3.
#   3. deps installed?       -> else offer `npm install` (or do it with --install),
#                               exit 3 if still missing.
# Then it execs the .mjs, forwarding ALL (non-wrapper) arguments unchanged.
#
# Usage:
#   ./estimate-run-cost.sh <runId> [...] --region <r> [--json] [--batch-id <id>] ...
#   ./estimate-run-cost.sh --install <runId> ...   # auto-install deps if missing
# --help is forwarded to the .mjs (prints full usage without needing AWS).

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MJS="$SCRIPT_DIR/estimate-run-cost.mjs"
MIN_NODE_MAJOR=20

AUTO_INSTALL=0
ARGS=""
for arg in "$@"; do
  if [ "$arg" = "--install" ]; then
    AUTO_INSTALL=1
  else
    ARGS="$ARGS \"$arg\""
  fi
done

die() {
  code=$1
  shift
  printf '%s\n' "$@" >&2
  exit "$code"
}

# --- 1. Node present? ------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  die 127 \
    "ERROR: Node.js is not installed (no 'node' on PATH)." \
    "" \
    "This cost estimator requires Node.js ${MIN_NODE_MAJOR}+ . Install it one of these ways:" \
    "  • macOS (Homebrew):   brew install node@22" \
    "  • nvm (any OS):       nvm install 20 && nvm use 20" \
    "  • Official installer: https://nodejs.org/en/download" \
    "" \
    "After installing, verify with:  node --version   (must be v${MIN_NODE_MAJOR} or newer)"
fi

# --- 2. Node >= MIN_NODE_MAJOR? --------------------------------------------
NODE_VER=$(node --version 2>/dev/null | sed 's/^v//')
NODE_MAJOR=$(printf '%s' "$NODE_VER" | cut -d. -f1)
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    die 3 "ERROR: could not determine the Node.js version (got '$NODE_VER')." \
          "Install Node.js ${MIN_NODE_MAJOR}+ : https://nodejs.org/en/download"
    ;;
esac
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die 3 \
    "ERROR: Node.js ${MIN_NODE_MAJOR}+ is required, but found v${NODE_VER}." \
    "This script uses the global fetch() API and targets Node 20." \
    "Upgrade Node and re-run. (brew upgrade node, nvm install 20, or https://nodejs.org/en/download)"
fi

# --- 3. dependencies installed? (local node_modules) -----------------------
if [ ! -d "$SCRIPT_DIR/node_modules/@aws-sdk/client-omics" ]; then
  if [ "$AUTO_INSTALL" -eq 1 ]; then
    printf 'Installing dependencies (npm install) ...\n' >&2
    ( cd "$SCRIPT_DIR" && npm install ) || die 3 "npm install failed in $SCRIPT_DIR."
  else
    die 3 \
      "ERROR: dependencies are not installed." \
      "Install them, then re-run:" \
      "  (cd \"$SCRIPT_DIR\" && npm install)" \
      "" \
      "Or let this wrapper do it for you:" \
      "  $0 --install $*"
  fi
fi

# --- 4. Hand off to Node, forwarding all (non-wrapper) args. ---------------
eval exec node "\"$MJS\"" $ARGS
