#!/usr/bin/env node
/**
 * plan-cost.mjs — standalone pre-run, assumption-driven what-if cost
 * calculator for AWS HealthOmics workflows (the Planning_CLI).
 *
 * This is a PRE-RUN planning estimate: it multiplies user-supplied
 * assumptions (runtime, scatter width, instance choice, storage mode/size)
 * by LIVE AWS Price List On-Demand rates. It is NOT a bill, and it does not
 * read any measured run data — for an executed run, use the sibling
 * post-run estimator (`dist-cost-estimator/estimate-run-cost.mjs`) instead.
 *
 * AWS permissions needed: read-only `pricing:GetProducts` /
 * `pricing:DescribeServices` only. No HealthOmics permission is required —
 * this tool never calls `omics:*`.
 *
 * The `--help` path below returns BEFORE any import of an AWS-touching
 * module (this file's only static imports are pure, no-I/O modules; the
 * AWS-touching `src/priceList.mjs` and `@aws-sdk/*` packages are loaded via
 * a dynamic `import()` only after the help/arg-validation gate has passed),
 * so usage can be checked fully offline, with no AWS credentials.
 *
 * Usage:
 *   plan-cost.mjs [--region <r>] [--interactive | --input <file> | --json] [--help|-h]
 *
 * Options:
 *   --region <r>     AWS region (or $AWS_REGION / $COST_REGION). Needed
 *                     before any price fetch; prompted for interactively if
 *                     unresolved, required for non-interactive mode.
 *   --interactive     Run the guided, progressive interactive flow (default
 *                     when no --input is given and stdin is a TTY).
 *   --input <file>    Run the deterministic non-interactive driver, reading
 *                     the planning-assumptions JSON from this file (or from
 *                     stdin if omitted and stdin is piped).
 *   --json            Emit machine-readable JSON (the full EstimateResult,
 *                     disclaimer included as a field) instead of rendered
 *                     tables. Can be combined with --input.
 *   --help, -h        Print this help and exit 0. Never imports the AWS SDK.
 *
 * Examples:
 *   plan-cost.mjs --help
 *   plan-cost.mjs --region us-east-1
 *   plan-cost.mjs --region us-east-1 --input plan.json --json
 *   echo '{"steps":[...],"storage":{...}}' | plan-cost.mjs --region us-east-1 --json
 */

import process from 'node:process';
import readline from 'node:readline';
import { estimate } from './src/estimationCore.mjs';
import { INSTANCE_SPECS } from './src/instanceSpecs.mjs';
import { renderInstanceMenu, renderRunningSummary, renderEstimate } from './src/render.mjs';
import { runNonInteractive } from './src/nonInteractiveDriver.mjs';
import { runInteractive } from './src/interactiveDriver.mjs';

const USAGE = `plan-cost — AWS HealthOmics pre-run cost-planning assistant (what-if calculator)

ESTIMATE ONLY — NOT A BILL. See the full disclaimer printed with every estimate.

Usage:
  plan-cost.mjs [--region <r>] [--interactive | --input <file> | --json] [--help|-h]

Options:
  --region <r>     AWS region (or $AWS_REGION / $COST_REGION).
  --interactive    Run the guided interactive flow (default without --input).
  --input <file>   Run the non-interactive driver with assumptions from <file>.
  --json           Emit machine-readable JSON instead of rendered tables.
  --help, -h       Print this help and exit. Never imports the AWS SDK.

Examples:
  plan-cost.mjs --help
  plan-cost.mjs --region us-east-1
  plan-cost.mjs --region us-east-1 --input plan.json --json
  echo '{"steps":[{"label":"align","instanceType":"omics.m.large","runtime":"45m","scatter":4}],"storage":{"mode":"STATIC","sizeGiB":100}}' \\
    | plan-cost.mjs --region us-east-1 --json
`;

/**
 * Parse argv into `{ region, interactive, inputFile, json, help }` or
 * `{ error: string }` for an unknown flag / malformed value. Pure; no I/O.
 *
 * @param {string[]} argv - e.g. `process.argv.slice(2)`.
 */
export function parseArgs(argv) {
  const result = { region: null, interactive: undefined, inputFile: null, json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--region': {
        const value = argv[i + 1];
        if (value === undefined) {
          return { error: '--region requires a value (e.g. --region us-east-1)' };
        }
        result.region = value;
        i += 1;
        break;
      }
      case '--interactive':
        result.interactive = true;
        break;
      case '--input': {
        const value = argv[i + 1];
        if (value === undefined) {
          return { error: '--input requires a file path' };
        }
        result.inputFile = value;
        result.interactive = false;
        i += 1;
        break;
      }
      case '--json':
        result.json = true;
        break;
      default:
        return { error: `Unknown option "${arg}". Run with --help for usage.` };
    }
  }

  return result;
}

/**
 * Resolve the region from (in precedence order): the parsed `--region` flag,
 * `$AWS_REGION`, `$COST_REGION`, else `null`. Returns `{ region, source }`
 * where `source` is `'flag'`, `'AWS_REGION'`, `'COST_REGION'`, or `null`, so
 * callers can label an environment-derived default per Req 9.6.
 *
 * @param {string|null} flagRegion
 * @param {Record<string,string|undefined>} env
 */
export function resolveRegion(flagRegion, env = process.env) {
  if (flagRegion) {
    return { region: flagRegion, source: 'flag' };
  }
  if (env.AWS_REGION) {
    return { region: env.AWS_REGION, source: 'AWS_REGION' };
  }
  if (env.COST_REGION) {
    return { region: env.COST_REGION, source: 'COST_REGION' };
  }
  return { region: null, source: null };
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if ('error' in parsed) {
    process.stderr.write(`Error: ${parsed.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  const { region, source } = resolveRegion(parsed.region);

  // Everything below this point may need AWS. Import the AWS-touching
  // module(s) dynamically, ONLY now that --help/arg-validation have passed.
  const { fetchRateMap } = await import('./src/priceList.mjs');
  const { PricingClient } = await import('@aws-sdk/client-pricing');

  const runningInteractive = parsed.interactive !== false && parsed.inputFile === null;

  if (runningInteractive) {
    if (region === null) {
      process.stderr.write(
        'No region resolved from --region, $AWS_REGION, or $COST_REGION. ' +
          'The interactive flow will prompt for one.\n',
      );
    } else if (source !== 'flag') {
      process.stdout.write(`Using region ${region} from $${source} (override with --region)\n`);
    }

    const pricingClient = new PricingClient({});
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = (question) => new Promise((resolve) => rl.question(question, resolve));
    const print = (text) => process.stdout.write(`${text}\n`);

    try {
      await runInteractive({
        region,
        pricingClient,
        prompt,
        print,
        fetchRateMap,
        instanceSpecs: INSTANCE_SPECS,
        estimate,
        renderInstanceMenu,
        renderRunningSummary,
        renderEstimate,
      });
    } finally {
      rl.close();
    }
    return;
  }

  // Non-interactive mode.
  if (region === null) {
    process.stderr.write(
      'Error: no region resolved. Pass --region, or set $AWS_REGION / $COST_REGION.\n',
    );
    process.exitCode = 2;
    return;
  }
  if (source !== 'flag') {
    process.stderr.write(`Using region ${region} from $${source} (override with --region)\n`);
  }

  const pricingClient = new PricingClient({});
  const { exitCode, output } = await runNonInteractive({
    inputFile: parsed.inputFile,
    region,
    pricingClient,
    json: parsed.json,
    fetchRateMap,
    instanceSpecs: INSTANCE_SPECS,
    estimate,
    renderEstimate,
    readStdin: () => readStdinToString(process.stdin),
  });

  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  process.exitCode = exitCode;
}

/** Read all of stdin into a string (used when --input is omitted). */
function readStdinToString(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

// Only run main() when this file is executed directly (not when imported by
// a test), so `node --test` can import parseArgs/resolveRegion without
// triggering the CLI's I/O.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
