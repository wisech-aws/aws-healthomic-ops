#!/bin/sh
# estimate-run-cost.sh — environment-safe launcher for estimate-run-cost.mjs.
#
# The cost estimator is a Node ESM script. If Node is NOT installed, running the
# .mjs directly fails with a cryptic shell error (`node: command not found` or
# `env: node: No such file or directory`) and the in-script preflight never gets
# a chance to help — because that preflight runs *inside* Node.
#
# This POSIX /bin/sh wrapper runs BEFORE Node and guarantees the environment is
# usable, with actionable guidance when it is not:
#   1. Node present?         -> else print how to install Node and exit 127.
#   2. Node >= 20?           -> else print the version problem and exit 3.
#   3. ingest deps installed -> else offer to run `npm install` (or do it with
#                               --install) and exit 3 if still missing.
# Then it execs the .mjs, forwarding ALL arguments unchanged.
#
# Usage is identical to the .mjs, plus one wrapper-only flag:
#   scripts/estimate-run-cost.sh <runId> [...] --region <r> [--json] [...]
#   scripts/estimate-run-cost.sh --install <runId> ...   # auto-install deps if missing
#
# `--help` is forwarded to the .mjs (which prints full usage without needing AWS).

set -eu

# Resolve this script's own directory (POSIX; handles being called via PATH or
# a relative path). Does not resolve symlinks, which is fine for locating the
# sibling .mjs and the ingest dir.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MJS="$SCRIPT_DIR/estimate-run-cost.mjs"
INGEST_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)/ingest
MIN_NODE_MAJOR=20

# Wrapper-only flag: --install auto-installs ingest deps if missing. Strip it so
# it is NOT forwarded to the .mjs (which would reject it as an unknown option).
AUTO_INSTALL=0
ARGS=""
for arg in "$@"; do
  if [ "$arg" = "--install" ]; then
    AUTO_INSTALL=1
  else
    # Re-quote each arg so values with spaces survive the rebuild.
    ARGS="$ARGS \"$arg\""
  fi
done

die() {
  # $1 = exit code, rest = message lines on stderr.
  code=$1
  shift
  printf '%s\n' "$@" >&2
  exit "$code"
}

# --- 1. Node present? -------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  die 127 \
    "ERROR: Node.js is not installed (no 'node' on PATH)." \
    "" \
    "This cost estimator requires Node.js ${MIN_NODE_MAJOR}+ . Install it one of these ways:" \
    "  • macOS (Homebrew):   brew install node@22" \
    "  • nvm (any OS):       nvm install 20 && nvm use 20" \
    "  • Official installer: https://nodejs.org/en/download" \
    "" \
    "After installing, verify with:  node --version   (must be v${MIN_NODE_MAJOR} or newer)" \
    "then re-run:  $0 $*"
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
    "This script uses the global fetch() API (stable from Node 18) and targets the repo's Node 20 toolchain." \
    "Upgrade Node and re-run. (brew upgrade node, nvm install 20, or https://nodejs.org/en/download)"
fi

# --- 3. ingest dependencies installed? -------------------------------------
# A cheap proxy for "deps installed": the omics client dir exists. The .mjs
# preflight does the authoritative, exhaustive module check; this is just so the
# wrapper can offer to install before handing off.
if [ ! -d "$INGEST_DIR/node_modules/@aws-sdk/client-omics" ]; then
  if [ "$AUTO_INSTALL" -eq 1 ]; then
    printf 'Installing ingest dependencies (cd %s && npm install) ...\n' "$INGEST_DIR" >&2
    ( cd "$INGEST_DIR" && npm install ) || die 3 "npm install failed in $INGEST_DIR."
  else
    die 3 \
      "ERROR: the ingest package's dependencies are not installed." \
      "The estimator loads the AWS SDK from: $INGEST_DIR/node_modules" \
      "" \
      "Install them, then re-run:" \
      "  (cd \"$INGEST_DIR\" && npm install)" \
      "" \
      "Or let this wrapper do it for you:" \
      "  $0 --install $*"
  fi
fi

# --- 4. Hand off to the Node script, forwarding all (non-wrapper) args. -----
# `eval` re-expands the re-quoted ARGS so quoted values are preserved.
eval exec node "\"$MJS\"" $ARGS
