#!/usr/bin/env bash
#
# deploy.sh — build and deploy the HealthOmics Workflow Dashboard in one command.
#
# Encodes the CORRECT deploy sequence so `dist`/Lambda bundles are always fresh
# and the stacks deploy in the right order:
#
#   1. build ingest  (so the Lambda bundles — ingest, metrics, cost, reports —
#                     are compiled from current source before CDK bundles them),
#   2. build the SPA (so FrontendStack uploads the CURRENT frontend/dist, not a
#                     stale or missing build — the #1 deploy footgun),
#   3. cdk deploy    (CDK resolves cross-stack order: Data -> Api -> Ingest,
#                     Api -> Frontend).
#
# This exists because `cdk deploy --all` alone does NOT build the SPA, so a bare
# deploy can publish stale assets. Prefer this script over calling cdk directly.
#
# IMPORTANT — do not hand-edit the AppSync API auth with `aws appsync
# update-graphql-api`: that call REPLACES the whole auth config and will drop
# the IAM additional-auth provider the ingest Lambda needs to publish (causing
# HTTP 401 on publishRunUpdate/publishTaskUpdate). CDK is the source of truth
# for auth; if the live API ever drifts, restore it by re-including BOTH the
# Cognito default AND `--additional-authentication-providers
# '[{"authenticationType":"AWS_IAM"}]'` (or redeploy from a clean CFN state).
#
# Usage:
#   scripts/deploy.sh                        # build ingest + SPA, deploy all stacks
#   scripts/deploy.sh --frontend-only        # build SPA, deploy only HealthOmicsFrontend
#   scripts/deploy.sh --stack HealthOmicsApi # build, deploy one named stack
#   scripts/deploy.sh --skip-build           # deploy without rebuilding (use with care)
#   scripts/deploy.sh --region us-west-2     # override region (default: $AWS_REGION or us-east-1)
#   scripts/deploy.sh --help
#
# Requires: AWS credentials for the target account, and `cdk bootstrap` already
# run once per account/region. Deploys are billable.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INGEST_DIR="${REPO_ROOT}/ingest"
FRONTEND_DIR="${REPO_ROOT}/frontend"
INFRA_DIR="${REPO_ROOT}/infra"

STACK="--all"
FRONTEND_ONLY=0
DO_BUILD=1
REGION="${AWS_REGION:-us-east-1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --frontend-only) FRONTEND_ONLY=1; STACK="HealthOmicsFrontend"; shift ;;
    --stack) STACK="${2:?--stack requires a value}"; shift 2 ;;
    --skip-build) DO_BUILD=0; shift ;;
    --region) REGION="${2:?--region requires a value}"; shift 2 ;;
    -h|--help)
      sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1 (use --help)"; exit 2 ;;
  esac
done

# Resolve the deploying account so CDK env (account/region) is explicit and the
# operator can see what they're about to deploy into.
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Deploying to account ${ACCOUNT} / region ${REGION} — stack(s): ${STACK}"

if [ "${DO_BUILD}" -eq 1 ]; then
  if [ "${FRONTEND_ONLY}" -eq 0 ]; then
    echo "==> Building ingest (Lambda bundles source)…"
    ( cd "${INGEST_DIR}" && npm run build )
  fi
  echo "==> Building the SPA (frontend/dist)…"
  ( cd "${FRONTEND_DIR}" && npm run build )
else
  echo "==> Skipping build (--skip-build)."
fi

echo "==> cdk deploy ${STACK}…"
(
  cd "${INFRA_DIR}"
  CDK_DEFAULT_ACCOUNT="${ACCOUNT}" CDK_DEFAULT_REGION="${REGION}" \
    npx cdk deploy ${STACK} --require-approval never
)

echo "Done."
