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
# SECURITY — Cognito hardening is defined in CDK (infra/lib/api-stack.ts) and
# applied by this deploy; do NOT weaken it out-of-band:
#   * Strong password policy: min 12 chars, upper+lower+digit+symbol, last-3
#     password history, 1-day temporary-password validity. A password set via
#     `admin-set-user-password` MUST satisfy all of these or Cognito rejects it.
#   * Brute-force / credential-stuffing protection: Cognito PLUS feature plan
#     with threat protection ENFORCED (StandardThreatProtectionMode.FULL_FUNCTION)
#     + app-client preventUserExistenceErrors. (PLUS bills per monthly active
#     user.) Access/ID tokens 1h, refresh 30d.
# Editing these live via the console/CLI causes CFN drift; change them in CDK
# and redeploy instead.
#
# Usage:
#   scripts/deploy.sh                        # build ingest + SPA, deploy all stacks
#   scripts/deploy.sh --frontend-only        # build SPA, deploy only HealthOmicsFrontend
#   scripts/deploy.sh --stack HealthOmicsApi # build, deploy one named stack
#   scripts/deploy.sh --skip-build           # deploy without rebuilding (use with care)
#   scripts/deploy.sh --region us-west-2     # override region (default: $AWS_REGION or us-east-1)
#   scripts/deploy.sh --kinesis-mode present # select the Kinesis ingest path (default: off)
#   scripts/deploy.sh --help
#
# --kinesis-mode <off|present|active> selects the HealthOmicsIngest ingest path
# (passed through to CDK as `-c kinesisIngestMode=<mode>`):
#   off     (default) direct EventBridge -> Lambda only (no Kinesis resources).
#   present also provision the Kinesis stream + consumer, but EventBridge still
#           targets the Lambda (the Kinesis path sits idle; ~$30/mo idle cost).
#   active  EventBridge targets the Kinesis stream (Kinesis becomes the live
#           ingest path). Toggle back to present/off with a single redeploy;
#           neither path is deleted on the toggle.
#
# Requires: AWS CLI on PATH, Node.js 20.x, each package's deps installed
# (`npm install` in ingest/, frontend/, infra/), AWS credentials for the target
# account, and `cdk bootstrap` already run once per account/region. This script
# checks these prerequisites and fails fast with guidance; it NEVER auto-installs,
# auto-bootstraps, or deploys without those in place. Deploys are billable.
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
KINESIS_MODE="off"

while [ $# -gt 0 ]; do
  case "$1" in
    --frontend-only) FRONTEND_ONLY=1; STACK="HealthOmicsFrontend"; shift ;;
    --stack) STACK="${2:?--stack requires a value}"; shift 2 ;;
    --skip-build) DO_BUILD=0; shift ;;
    --region) REGION="${2:?--region requires a value}"; shift 2 ;;
    --kinesis-mode)
      KINESIS_MODE="${2:?--kinesis-mode requires a value (off|present|active)}"
      case "${KINESIS_MODE}" in
        off|present|active) ;;
        *)
          echo "error: --kinesis-mode must be one of: off, present, active (got '${KINESIS_MODE}')" >&2
          exit 2
          ;;
      esac
      shift 2
      ;;
    -h|--help)
      sed -n '2,61p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1 (use --help)"; exit 2 ;;
  esac
done

# --- Prerequisite checks ----------------------------------------------------
# Fail fast with clear, actionable guidance. This script NEVER auto-installs,
# auto-bootstraps, or deploys when a prerequisite is missing.

# 1) AWS CLI on PATH.
if ! command -v aws >/dev/null 2>&1; then
  echo "error: AWS CLI not found on PATH. Install the AWS CLI v2 and retry:" >&2
  echo "       https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 1
fi

# 2) Node present and v20.x (warn, don't fail, on other majors).
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed. Install Node.js 20.x and retry." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" != "20" ]; then
  echo "warning: Node ${NODE_MAJOR}.x detected; this project targets Node 20.x." >&2
fi

# 3) node_modules present in each package this run will build/deploy from.
#    Full deploy: ingest + frontend + infra. --frontend-only: frontend + infra.
#    --skip-build: no build, but cdk still runs from infra/, so infra is needed.
MISSING_DEPS=0
check_node_modules() {
  # $1 = package directory
  if [ ! -d "$1/node_modules" ]; then
    echo "error: dependencies not installed in $1" >&2
    echo "       run: cd $1 && npm install" >&2
    MISSING_DEPS=1
  fi
}
if [ "${DO_BUILD}" -eq 1 ]; then
  if [ "${FRONTEND_ONLY}" -eq 0 ]; then
    check_node_modules "${INGEST_DIR}"
  fi
  check_node_modules "${FRONTEND_DIR}"
fi
check_node_modules "${INFRA_DIR}"
if [ "${MISSING_DEPS}" -ne 0 ]; then
  echo "Install the missing dependencies above, then re-run this script." >&2
  exit 1
fi

# 4) CDK CLI resolves from infra/ WITHOUT triggering a network install.
if ! ( cd "${INFRA_DIR}" && npx --no-install cdk --version >/dev/null 2>&1 ); then
  echo "error: the AWS CDK CLI could not be resolved from ${INFRA_DIR}." >&2
  echo "       run 'npm install' in infra/ first: cd ${INFRA_DIR} && npm install" >&2
  exit 1
fi

# 5) AWS credentials resolve. Reuse the account this returns for CDK env below.
if ! ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"; then
  echo "error: could not resolve AWS credentials." >&2
  echo "       configure AWS credentials (aws configure, or set AWS_PROFILE), then retry." >&2
  exit 1
fi

# 6) CDK bootstrap present in the target region. Detected by EITHER the
#    CDKToolkit stack OR the bootstrap version SSM parameter. DO NOT auto-bootstrap.
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "${REGION}" >/dev/null 2>&1 \
  && ! aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version --region "${REGION}" >/dev/null 2>&1; then
  echo "error: this account/region is not CDK-bootstrapped (account ${ACCOUNT}, region ${REGION})." >&2
  echo "       bootstrap once, then re-run this script:" >&2
  echo "       cd infra && npx cdk bootstrap aws://${ACCOUNT}/${REGION}" >&2
  exit 1
fi

# --- Pre-deploy summary -----------------------------------------------------
echo "Deploying to account ${ACCOUNT} / region ${REGION} — stack(s): ${STACK}"
echo "Kinesis ingest mode: ${KINESIS_MODE}"
echo ""
echo "Stacks and what each needs:"
echo "  HealthOmicsData     DynamoDB single table (the data store)."
echo "  HealthOmicsApi      AppSync GraphQL API + Cognito user pool (sign-in)."
echo "  HealthOmicsIngest   EventBridge rule + ingest Lambda. MUST deploy in the"
echo "                      SAME region as your HealthOmics runs so events arrive."
echo "  HealthOmicsFrontend S3 + CloudFront hosting for the SPA (needs frontend/dist)."
echo ""

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

# Pass the Kinesis mode through to CDK only when non-default, so the default
# deploy invocation stays byte-identical to prior behavior (the stack defaults
# to 'off' on its own).
CDK_CONTEXT_ARGS=""
if [ "${KINESIS_MODE}" != "off" ]; then
  CDK_CONTEXT_ARGS="-c kinesisIngestMode=${KINESIS_MODE}"
fi

echo "==> cdk deploy ${STACK}…"
(
  cd "${INFRA_DIR}"
  CDK_DEFAULT_ACCOUNT="${ACCOUNT}" CDK_DEFAULT_REGION="${REGION}" \
    npx cdk deploy ${STACK} ${CDK_CONTEXT_ARGS} --require-approval never
)

echo "Done."

# --- Next steps (full deploy only) ------------------------------------------
# Only after a full deploy do all the stacks exist, so these steps apply.
if [ "${STACK}" = "--all" ]; then
  echo ""
  echo "NEXT STEPS:"
  echo "  1. Create your first sign-in user (self-signup is disabled):"
  echo "       scripts/create-cognito-user.sh --username you@example.com"
  echo "  2. Open the dashboard: the URL is the HealthOmicsFrontend"
  echo "     'DistributionDomainName' CloudFront domain in the deploy outputs above"
  echo "     (https://<DistributionDomainName>). Sign in with the user from step 1."
  echo "  3. (Optional, per run role) grant run-metrics emission so runs report"
  echo "     CPU/memory utilization:"
  echo "       node scripts/ensure-run-metrics-permission.mjs --role-name <your-run-role-name>"
fi
