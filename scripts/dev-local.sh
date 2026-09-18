#!/usr/bin/env bash
#
# dev-local.sh — start the HealthOmics Workflow Dashboard frontend locally with
# a single command.
#
# This runs the React SPA against LOCAL PLACEHOLDER config so you can see and
# click through the UI without deploying any AWS infrastructure. With no real
# AppSync backend, the fleet view will render its empty/error state — that is
# the expected "local, no-AWS" experience.
#
# To point the local dev server at a REAL deployed backend instead, either:
#   * run `node scripts/inject-config.mjs --outputs cdk-outputs.json --out frontend/.env.local`
#     after `cdk deploy`, or
#   * export VITE_APPSYNC_ENDPOINT / VITE_USER_POOL_ID / VITE_USER_POOL_CLIENT_ID
#     / VITE_AWS_REGION before running this script.
#
# Usage:
#   scripts/dev-local.sh              # install deps if needed, then start dev server
#   scripts/dev-local.sh --no-install # skip the dependency install check
#   scripts/dev-local.sh --port 3000  # start on a specific port
#   scripts/dev-local.sh --help
#
set -euo pipefail

# Resolve the repo root from this script's location so the command works from
# any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"

INSTALL=1
PORT=5173

while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) INSTALL=0; shift ;;
    --port) PORT="${2:?--port requires a value}"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# --- Prerequisite checks ----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed. Install Node.js 20+ and retry." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "warning: Node ${NODE_MAJOR} detected; this project targets Node 20+." >&2
fi

# --- Local placeholder config (only written if none exists) -----------------
# The SPA reads its config from VITE_* env vars (see frontend/src/api/config.ts).
#
# IMPORTANT: this is written to `.env.development`, which Vite loads ONLY in dev
# (`vite`/serve) mode — never in a production `vite build`. This guarantees the
# mock flag can never leak into a deployed bundle. (An earlier version wrote
# `.env.local`, which Vite loads in ALL modes and so contaminated production
# builds with VITE_LOCAL_MOCK=true.)
ENV_DEV="${FRONTEND_DIR}/.env.development"
if [ ! -f "${ENV_DEV}" ] && [ -z "${VITE_APPSYNC_ENDPOINT:-}" ]; then
  echo "Writing local placeholder config to frontend/.env.development ..."
  cat > "${ENV_DEV}" << 'ENVEOF'
# Local dev placeholder config for `scripts/dev-local.sh`. Loaded by Vite ONLY
# in dev/serve mode (never in `vite build`), so it cannot affect deployments.
# VITE_LOCAL_MOCK=true makes the GraphQL client serve in-memory sample data and
# no-op subscriptions instead of calling AppSync, so the UI runs with no
# deployed backend and no Cognito sign-in (no "No federated jwt" error).
# To dev against a REAL backend, set VITE_LOCAL_MOCK=false here and fill in the
# real endpoint/pool values (see scripts/inject-config.mjs).
VITE_LOCAL_MOCK=true
VITE_APPSYNC_ENDPOINT=https://local-placeholder.appsync-api.us-east-1.amazonaws.com/graphql
VITE_USER_POOL_ID=us-east-1_localdev
VITE_USER_POOL_CLIENT_ID=localdevclient
VITE_AWS_REGION=us-east-1
ENVEOF
else
  echo "Using existing frontend config (.env.development or exported VITE_* vars)."
fi

# --- Install dependencies (only if node_modules is missing) -----------------
if [ "${INSTALL}" -eq 1 ] && [ ! -d "${FRONTEND_DIR}/node_modules" ]; then
  echo "Installing frontend dependencies (first run) ..."
  ( cd "${FRONTEND_DIR}" && npm install )
fi

# --- Start the dev server ---------------------------------------------------
echo ""
echo "Starting the dashboard dev server on http://localhost:${PORT}"
echo "Press Ctrl+C to stop."
echo ""
cd "${FRONTEND_DIR}"
exec npm run dev -- --port "${PORT}" --open
