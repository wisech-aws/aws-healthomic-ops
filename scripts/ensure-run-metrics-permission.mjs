#!/usr/bin/env node
/**
 * ensure-run-metrics-permission.mjs — idempotent run-role metric-emission
 * permission (Req 4.3; Design "IAM/emission note").
 *
 * HealthOmics only EMITS `aws.omics.*` run/task utilization metrics to
 * CloudWatch for a run if the run's IAM service role holds
 * `cloudwatch:PutMetricData` at the time the run starts (see AWS docs —
 * "Enabling metrics for a run":
 * https://docs.aws.amazon.com/omics/latest/dev/monitoring-run-metrics.html).
 * This is entirely separate from, and a precondition for, the dashboard's
 * `getRunMetrics` READ path (which needs `cloudwatch:GetMetricData` /
 * `cloudwatch:ListMetrics` on the *reader* role — that grant lives in
 * `infra/lib/api-stack.ts`, not here). The run role is a HealthOmics service
 * role, not created by this repo's CDK, so it cannot be added to a stack —
 * this script manages it out-of-band instead.
 *
 * This script idempotently ENSURES an inline policy on that run role granting
 * `cloudwatch:PutMetricData` (Resource "*", as required — PutMetricData does
 * not support resource-level ARN scoping). It is SAFE TO RE-RUN: it checks the
 * role's current inline policy (if any) via `GetRolePolicy` and only calls the
 * (idempotent/upsert) `PutRolePolicy` when the policy is missing or differs
 * from the desired document, so re-running it never duplicates statements or
 * fails because the policy already exists.
 *
 * IMPORTANT — cost note: granting `cloudwatch:PutMetricData` enables CloudWatch
 * metric ingestion for runs using this role from then on. CloudWatch bills for
 * metric ingestion, storage, and (for high-resolution/embedded-metric use)
 * custom metrics — see https://aws.amazon.com/cloudwatch/pricing/. Runs started
 * BEFORE this policy is applied never emit metrics retroactively (Req 4.3).
 *
 * IMPORTANT — default role: `OmicsWorkflow-20260224075057` is the run role
 * used in THIS PROJECT'S TEST/dev environment only. Pass --role-name (or set
 * $RUN_ROLE_NAME) to target the correct role in any other account/environment
 * — do not rely on the default outside this project's test setup.
 *
 * The `--help` path never imports the AWS SDK and never touches AWS, so usage
 * can be checked without credentials. `--dry-run` performs the same read-only
 * checks as a normal run (via `GetRole`/`GetRolePolicy`, so it DOES need the
 * SDK and credentials) but is GUARANTEED to skip the mutating
 * `PutRolePolicy` call — it only ever reports what would happen. The AWS SDK
 * (`@aws-sdk/client-iam`) is imported lazily, only once we know we are not
 * just printing help.
 *
 * Usage:
 *   scripts/ensure-run-metrics-permission.mjs [options]
 *
 * Options:
 *   --role-name <name>    HealthOmics run role to grant the policy to.
 *                          Defaults to $RUN_ROLE_NAME, or
 *                          "OmicsWorkflow-20260224075057" (this project's TEST
 *                          environment role — override for other accounts).
 *   --region <region>     AWS region for client construction (or $AWS_REGION).
 *                          IAM is a global service; this only affects which
 *                          regional endpoint/partition the client resolves,
 *                          kept for consistency with the other scripts here.
 *   --policy-name <name>  Inline policy name to create/update. Defaults to
 *                          "HealthOmicsRunMetrics-PutMetricData".
 *   --dry-run              Check current state and print what WOULD be done;
 *                          never calls PutRolePolicy (no mutation).
 *   --help, -h              Print this help and exit. Never imports the SDK.
 *
 * Examples:
 *   # See usage without touching AWS or needing credentials:
 *   scripts/ensure-run-metrics-permission.mjs --help
 *
 *   # Check the default TEST-environment role without changing anything:
 *   scripts/ensure-run-metrics-permission.mjs --dry-run
 *
 *   # Ensure the policy on a specific role in a specific region:
 *   scripts/ensure-run-metrics-permission.mjs \
 *       --role-name MyOmicsRunRole --region us-west-2
 *
 * SDK resolution note: `@aws-sdk/client-iam` is not currently a dependency of
 * any package.json in this repo (checked ingest/, infra/, frontend/). This
 * mirrors `send-event.mjs`, whose `@aws-sdk/client-eventbridge` /
 * `@aws-sdk/client-lambda` imports are likewise not declared anywhere in this
 * repo (see scripts/README.md: "Run the script with a Node.js resolution
 * context that provides those"). No dependency was added to any package.json
 * for this script; before running it in a real (non-`--help`) mode, make sure
 * `@aws-sdk/client-iam` is resolvable from this file's location, e.g.:
 *   npm install @aws-sdk/client-iam   (in a directory on the Node resolution
 *   path for this script, or run via `npx --package=@aws-sdk/client-iam`).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants — kept in lockstep with the AWS docs' "Enabling metrics for a
// run" guidance: HealthOmics needs `cloudwatch:PutMetricData` on the run role
// to emit run/task utilization metrics for future runs.
// ---------------------------------------------------------------------------

// NOTE: this default is specific to THIS PROJECT'S TEST environment. Override
// with --role-name / $RUN_ROLE_NAME for any other account or role.
const DEFAULT_ROLE_NAME = 'OmicsWorkflow-20260224075057';
const DEFAULT_POLICY_NAME = 'HealthOmicsRunMetrics-PutMetricData';

/** The inline policy document this script ensures is attached to the run role. */
const DESIRED_POLICY_DOCUMENT = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AllowHealthOmicsRunMetrics',
      Effect: 'Allow',
      Action: 'cloudwatch:PutMetricData',
      Resource: '*',
    },
  ],
};

/** Thrown for usage errors (bad/missing args). Carries a clear message. */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const HELP_TEXT = `ensure-run-metrics-permission.mjs — idempotently grant a HealthOmics run role
cloudwatch:PutMetricData so it can EMIT run/task utilization metrics.

Usage:
  ensure-run-metrics-permission.mjs [options]

Options:
  --role-name <name>    Run role to grant the policy to. Defaults to
                         $RUN_ROLE_NAME, or "${DEFAULT_ROLE_NAME}"
                         (this project's TEST environment role only — pass
                         --role-name for any other account/role).
  --region <region>     AWS region for client construction (or $AWS_REGION).
                         IAM is global; kept for consistency with other
                         scripts here.
  --policy-name <name>  Inline policy name to create/update. Defaults to
                         "${DEFAULT_POLICY_NAME}".
  --dry-run              Check current state and print what WOULD be done;
                         never calls PutRolePolicy (no mutation).
  --help, -h              Show this help. Never imports the AWS SDK.

Examples:
  ensure-run-metrics-permission.mjs --help
  ensure-run-metrics-permission.mjs --dry-run
  ensure-run-metrics-permission.mjs --role-name MyOmicsRunRole --region us-west-2

Grants cloudwatch:PutMetricData (Resource "*") via an inline role policy. This
enables CloudWatch metric ingestion (billed by CloudWatch) for runs using this
role from then on. Runs started before this is applied never emit metrics
retroactively.
`;

/**
 * Parse argv into an options object. Unknown flags are an error so operator
 * typos never silently fall through to touching the wrong role.
 */
function parseArgs(argv) {
  const opts = {
    roleName: process.env.RUN_ROLE_NAME ?? DEFAULT_ROLE_NAME,
    region: process.env.AWS_REGION,
    policyName: DEFAULT_POLICY_NAME,
    dryRun: false,
    help: false,
  };

  const takesValue = new Set(['--role-name', '--region', '--policy-name']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ValidationError(`Missing value for ${arg}`);
      }
      i += 1;
      switch (arg) {
        case '--role-name':
          opts.roleName = value;
          break;
        case '--region':
          opts.region = value;
          break;
        case '--policy-name':
          opts.policyName = value;
          break;
      }
      continue;
    }
    throw new ValidationError(`Unknown argument: ${arg}`);
  }

  if (!opts.roleName || opts.roleName.trim().length === 0) {
    throw new ValidationError(
      'A role name is required (via --role-name or $RUN_ROLE_NAME).',
    );
  }
  if (!opts.policyName || opts.policyName.trim().length === 0) {
    throw new ValidationError('--policy-name must not be empty.');
  }

  return opts;
}

/**
 * Deep-compare two JSON-parseable values, ignoring object key order (IAM may
 * echo the policy document back with different key ordering/whitespace than
 * what was submitted).
 */
export function deepEqualJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqualJson(item, b[i]));
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key, i) => key === bKeys[i] && deepEqualJson(a[key], b[key]),
    );
  }
  return a === b;
}

/**
 * Fetch the role's current named inline policy document, or `null` if the
 * role has no such inline policy yet. Throws for any other failure (e.g. the
 * role itself does not exist).
 */
async function getCurrentPolicyDocument(client, GetRolePolicyCommand, roleName, policyName) {
  try {
    const response = await client.send(
      new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
    );
    // IAM returns the policy document URL-encoded JSON.
    const decoded = decodeURIComponent(response.PolicyDocument ?? '');
    return JSON.parse(decoded);
  } catch (err) {
    if (err?.name === 'NoSuchEntityException') {
      // Normal case: the role exists but this inline policy does not yet.
      return null;
    }
    throw err;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  // Lazy SDK import: never pulled in for --help, so usage can be checked
  // without credentials or the SDK installed.
  const { IAMClient, GetRoleCommand, GetRolePolicyCommand, PutRolePolicyCommand } =
    await import('@aws-sdk/client-iam');

  const client = new IAMClient(opts.region ? { region: opts.region } : {});

  process.stdout.write(
    `Role:        ${opts.roleName}\n` +
      `Policy name: ${opts.policyName}\n` +
      (opts.region ? `Region:      ${opts.region}\n` : ''),
  );

  // Confirm the role exists first, for a clear error message rather than a
  // confusing NoSuchEntityException surfaced from GetRolePolicy.
  try {
    await client.send(new GetRoleCommand({ RoleName: opts.roleName }));
  } catch (err) {
    if (err?.name === 'NoSuchEntityException') {
      throw new Error(`IAM role "${opts.roleName}" does not exist.`);
    }
    throw err;
  }

  const currentDocument = await getCurrentPolicyDocument(
    client,
    GetRolePolicyCommand,
    opts.roleName,
    opts.policyName,
  );

  let action;
  if (currentDocument === null) {
    action = 'create';
  } else if (deepEqualJson(currentDocument, DESIRED_POLICY_DOCUMENT)) {
    action = 'none';
  } else {
    action = 'update';
  }

  if (opts.dryRun) {
    if (action === 'none') {
      process.stdout.write(
        '[dry-run] Policy already exists and matches the desired document. ' +
          'No changes would be made.\n',
      );
    } else if (action === 'create') {
      process.stdout.write(
        '[dry-run] Policy does not exist yet. Would CREATE it with:\n' +
          `${JSON.stringify(DESIRED_POLICY_DOCUMENT, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        '[dry-run] Policy exists but differs from the desired document. ' +
          'Would UPDATE it to:\n' +
          `${JSON.stringify(DESIRED_POLICY_DOCUMENT, null, 2)}\n` +
          `Current document:\n${JSON.stringify(currentDocument, null, 2)}\n`,
      );
    }
    process.stdout.write('No AWS mutations were made.\n');
    return;
  }

  if (action === 'none') {
    process.stdout.write('Already up to date, no changes made.\n');
    return;
  }

  await client.send(
    new PutRolePolicyCommand({
      RoleName: opts.roleName,
      PolicyName: opts.policyName,
      PolicyDocument: JSON.stringify(DESIRED_POLICY_DOCUMENT),
    }),
  );

  if (action === 'create') {
    process.stdout.write(
      `Created inline policy "${opts.policyName}" on role "${opts.roleName}" ` +
        'granting cloudwatch:PutMetricData.\n',
    );
  } else {
    process.stdout.write(
      `Updated inline policy "${opts.policyName}" on role "${opts.roleName}" ` +
        'to match the desired document.\n',
    );
  }
}

// Only run when executed directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    if (err instanceof ValidationError) {
      process.stderr.write(`Validation error: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    }
  });
}
