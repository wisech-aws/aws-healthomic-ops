#!/usr/bin/env node
/**
 * Build-time frontend config injection.
 *
 * Consumes the CDK stack outputs for the API stack and writes the four
 * `VITE_*` environment variables the frontend build reads (see
 * `frontend/src/api/config.ts`) into an env file. This is how the SPA gets its
 * AppSync endpoint, Cognito user pool ID, app client ID, and region without any
 * hardcoded environment values (Req 11.7).
 *
 * Produce the inputs with the CDK CLI, e.g.:
 *
 *   cd infra
 *   cdk deploy HealthOmicsApi --outputs-file ../cdk-outputs.json
 *
 * Then inject them:
 *
 *   node scripts/inject-config.mjs \
 *     --outputs cdk-outputs.json \
 *     --stack HealthOmicsApi \
 *     --out frontend/.env.production
 *
 * The `--outputs-file` JSON is shaped `{ "<StackName>": { "<OutputId>": "<value>" } }`.
 * The ApiStack emits these output ids (see infra/lib/api-stack.ts):
 *   GraphqlApiUrl, UserPoolId, UserPoolClientId, Region
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';

/** Maps a CDK output id to the Vite env var the frontend reads. */
const OUTPUT_TO_VITE_VAR = {
  GraphqlApiUrl: 'VITE_APPSYNC_ENDPOINT',
  UserPoolId: 'VITE_USER_POOL_ID',
  UserPoolClientId: 'VITE_USER_POOL_CLIENT_ID',
  Region: 'VITE_AWS_REGION',
};

/** Minimal `--flag value` argument parser. */
function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      parsed[arg.slice(2)] = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function main() {
  const {
    outputs = 'cdk-outputs.json',
    stack = 'HealthOmicsApi',
    out = 'frontend/.env.production',
  } = parseArgs(argv.slice(2));

  let raw;
  try {
    raw = readFileSync(outputs, 'utf8');
  } catch (err) {
    console.error(`Could not read CDK outputs file '${outputs}': ${err.message}`);
    console.error(
      "Generate it first, e.g. `cdk deploy <stack> --outputs-file cdk-outputs.json`.",
    );
    exit(1);
  }

  const all = JSON.parse(raw);
  const stackOutputs = all[stack];
  if (!stackOutputs) {
    console.error(
      `Stack '${stack}' not found in '${outputs}'. Available: ${Object.keys(all).join(', ') || '(none)'}`,
    );
    exit(1);
  }

  const lines = [];
  const missing = [];
  for (const [outputId, viteVar] of Object.entries(OUTPUT_TO_VITE_VAR)) {
    const value = stackOutputs[outputId];
    if (value === undefined || value === '') {
      missing.push(outputId);
      continue;
    }
    lines.push(`${viteVar}=${value}`);
  }

  if (missing.length > 0) {
    console.error(
      `Stack '${stack}' is missing required output(s): ${missing.join(', ')}.`,
    );
    exit(1);
  }

  writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${lines.length} VITE_* variables to ${out}.`);
}

main();
