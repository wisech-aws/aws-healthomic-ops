#!/usr/bin/env bash
#
# create-cognito-user.sh — create the first (admin-provisioned) sign-in user for
# the HealthOmics Workflow Dashboard.
#
# The API's default authorization is the Cognito user pool and SELF-SIGNUP IS
# DISABLED, so users must be created by an admin. This helper reads the user
# pool from the deployed HealthOmicsApi stack outputs (UserPoolId, Region) and
# the dashboard URL from the HealthOmicsFrontend stack output
# (DistributionDomainName), creates the user with a suppressed invite, and sets
# a PERMANENT password — so the user can sign in immediately.
#
# The password MUST satisfy the user pool's enforced policy:
#   * at least 12 characters,
#   * at least one lowercase, one uppercase, one digit, and one symbol.
# This script VALIDATES the password locally against that policy BEFORE calling
# AWS. It never generates, prints, or echoes a password.
#
# Usage:
#   scripts/create-cognito-user.sh --username you@example.com
#   scripts/create-cognito-user.sh --username alice --email alice@example.com
#   scripts/create-cognito-user.sh --username you@example.com --password '<StrongPassw0rd!>'
#   scripts/create-cognito-user.sh --username you@example.com --region us-west-2
#   scripts/create-cognito-user.sh --help
#
# Flags:
#   --username <u>  REQUIRED. The Cognito username (email alias is enabled, so an
#                   email address works well as the username).
#   --email <e>     Email attribute. Defaults to --username when it looks like an
#                   email (contains '@'); otherwise --email is REQUIRED.
#   --password <p>  OPTIONAL. If omitted, the enforced policy is printed and the
#                   password is read securely from the terminal (never echoed).
#   --region <r>    AWS region (default: $AWS_REGION, else us-east-1).
#   --help, -h      Show this help. Never contacts AWS.
#
# On success it prints the sign-in URL (the CloudFront domain) and the username,
# and reminds you that self-signup is disabled. If the user already exists, it
# updates (resets) that user's permanent password instead of failing.
#
# Requires: AWS CLI on PATH and a deployed HealthOmicsApi stack in the target
# region.
#
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
USERNAME=""
EMAIL=""
PASSWORD=""
PASSWORD_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --username) USERNAME="${2:?--username requires a value}"; shift 2 ;;
    --email) EMAIL="${2:?--email requires a value}"; shift 2 ;;
    --password) PASSWORD="${2:?--password requires a value}"; PASSWORD_SET=1; shift 2 ;;
    --region) REGION="${2:?--region requires a value}"; shift 2 ;;
    -h|--help)
      sed -n '2,41p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1 (use --help)" >&2; exit 2 ;;
  esac
done

# --- Policy text (printed when prompting; keep in sync with api-stack.ts) ----
print_password_policy() {
  echo "Password policy (enforced by the Cognito user pool):" >&2
  echo "  * at least 12 characters" >&2
  echo "  * at least one lowercase letter" >&2
  echo "  * at least one uppercase letter" >&2
  echo "  * at least one digit" >&2
  echo "  * at least one symbol (non-alphanumeric character)" >&2
}

# --- Argument validation ----------------------------------------------------
if [ -z "${USERNAME}" ]; then
  echo "error: --username is required (use --help)." >&2
  exit 2
fi

# Default the email to the username when it looks email-like; otherwise require
# --email explicitly so we never set a non-email value as the email attribute.
if [ -z "${EMAIL}" ]; then
  case "${USERNAME}" in
    *@*) EMAIL="${USERNAME}" ;;
    *)
      echo "error: --username '${USERNAME}' is not an email address, so --email is required." >&2
      exit 2
      ;;
  esac
fi

# --- Password: validate (or prompt then validate) BEFORE any AWS call -------
if [ "${PASSWORD_SET}" -eq 0 ]; then
  print_password_policy
  printf 'Enter a password for %s: ' "${USERNAME}" >&2
  # read -s suppresses echo so the password is never shown.
  read -r -s PASSWORD
  echo "" >&2
fi

# Validate against the enforced policy. Report EVERY unmet rule; never echo the
# password itself.
PW_ERRORS=""
if [ "${#PASSWORD}" -lt 12 ]; then
  PW_ERRORS="${PW_ERRORS}  * must be at least 12 characters\n"
fi
if ! printf '%s' "${PASSWORD}" | grep -q '[a-z]'; then
  PW_ERRORS="${PW_ERRORS}  * must contain a lowercase letter\n"
fi
if ! printf '%s' "${PASSWORD}" | grep -q '[A-Z]'; then
  PW_ERRORS="${PW_ERRORS}  * must contain an uppercase letter\n"
fi
if ! printf '%s' "${PASSWORD}" | grep -q '[0-9]'; then
  PW_ERRORS="${PW_ERRORS}  * must contain a digit\n"
fi
# A symbol = any character that is NOT a letter, digit, or whitespace.
if ! printf '%s' "${PASSWORD}" | grep -q '[^a-zA-Z0-9[:space:]]'; then
  PW_ERRORS="${PW_ERRORS}  * must contain a symbol (non-alphanumeric character)\n"
fi

if [ -n "${PW_ERRORS}" ]; then
  echo "error: the password does not meet the required policy:" >&2
  printf '%b' "${PW_ERRORS}" >&2
  exit 2
fi

# --- Prerequisite checks ----------------------------------------------------
if ! command -v aws >/dev/null 2>&1; then
  echo "error: AWS CLI not found on PATH. Install the AWS CLI v2 and retry." >&2
  exit 1
fi

# The HealthOmicsApi stack must be deployed to read the user pool from.
if ! aws cloudformation describe-stacks \
  --stack-name HealthOmicsApi --region "${REGION}" >/dev/null 2>&1; then
  echo "error: HealthOmicsApi stack not found in region ${REGION}." >&2
  echo "       deploy the backend first (scripts/deploy.sh), then re-run this." >&2
  exit 1
fi

# --- Resolve stack outputs --------------------------------------------------
get_output() {
  # $1 = stack name, $2 = output key
  aws cloudformation describe-stacks \
    --stack-name "$1" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text 2>/dev/null
}

USER_POOL_ID="$(get_output HealthOmicsApi UserPoolId)"
if [ -z "${USER_POOL_ID}" ] || [ "${USER_POOL_ID}" = "None" ]; then
  echo "error: could not read UserPoolId from the HealthOmicsApi stack outputs." >&2
  exit 1
fi

# The dashboard URL is best-effort: if the Frontend stack/output is missing we
# still create the user and just omit the URL line.
DOMAIN="$(get_output HealthOmicsFrontend DistributionDomainName)"

# --- Create (or reset) the user ---------------------------------------------
# Suppress the default Cognito invitation email; this is an admin-provisioned
# account and we set a permanent password immediately below.
CREATE_ERR=""
if ! CREATE_ERR="$(aws cognito-idp admin-create-user \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --user-attributes Name=email,Value="${EMAIL}" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region "${REGION}" 2>&1 1>/dev/null)"; then
  # Already-exists is not fatal: fall through to (re)set the permanent password.
  if printf '%s' "${CREATE_ERR}" | grep -q 'UsernameExistsException'; then
    echo "note: user '${USERNAME}' already exists — resetting the password." >&2
  else
    echo "error: failed to create user '${USERNAME}':" >&2
    printf '%s\n' "${CREATE_ERR}" >&2
    exit 1
  fi
fi

# Set a PERMANENT password so the user is immediately usable (not FORCE_CHANGE).
aws cognito-idp admin-set-user-password \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --password "${PASSWORD}" \
  --permanent \
  --region "${REGION}" >/dev/null

# --- Success output (never echo the password) -------------------------------
echo ""
echo "User '${USERNAME}' is ready to sign in."
if [ -n "${DOMAIN}" ] && [ "${DOMAIN}" != "None" ]; then
  echo "  Sign-in URL: https://${DOMAIN}"
else
  echo "  Sign-in URL: the HealthOmicsFrontend 'DistributionDomainName' CloudFront"
  echo "               domain (not found in outputs — deploy HealthOmicsFrontend)."
fi
echo "  Username:    ${USERNAME}"
echo ""
echo "Note: self-signup is disabled; users are admin-provisioned with this helper."
