#!/usr/bin/env node
/**
 * estimate-run-cost.mjs — standalone, UI-free per-run workflow cost ESTIMATOR.
 *
 * Given one or more HealthOmics run IDs, this script reproduces the dashboard's
 * per-run cost-estimate flow end to end using ONLY AWS APIs — it never reads the
 * dashboard's DynamoDB table, never uses the GraphQL API, and keeps no persisted
 * rate-card cache. Every number is a LIST-PRICE ESTIMATE from measured runtime ×
 * the published AWS Price List; it is NOT a bill and does NOT reflect any
 * discounts, credits, Savings Plans, Reserved pricing, taxes, or free-tier
 * allowances (see the prominent disclaimer printed with every readout).
 *
 * API path per run (AWS APIs only):
 *   1. omics:GetRun        -> startTime, stopTime, storageType, storageCapacity
 *   2. omics:ListRunTasks  -> per task: instanceType, startTime, stopTime
 *   3. pricing:GetProducts -> published On-Demand rate map (compute + storage)
 *   4. CloudWatch PromQL POST /api/v1/query_range  (DYNAMIC storage only)
 *                          -> run-level filesystem-usage series -> GB-hours
 *
 * Honesty about availability (no fabrication): any input that cannot be measured
 * or priced becomes an explicit "unavailable" line item with a reason; it is
 * never zero-filled. `total` is the sum of the AVAILABLE line items only, and is
 * marked PARTIAL when any line item is unavailable.
 *
 * Billing: AWS HealthOmics bills compute per task with a one-minute minimum
 * task duration charge (see "Run optimization for a private HealthOmics
 * workflow", https://docs.aws.amazon.com/omics/latest/dev/workflows-run-optimize.html).
 * Each task's measured runtime is floored to one minute PER TASK before being
 * aggregated by instance type, mirroring `ingest/src/cost/estimate.ts`.
 *
 * The pricing:GetProducts rate map is fetched ONCE and reused across all runs
 * (it is region-wide), so estimating a group of runs issues one Price List
 * pagination, not one per run.
 *
 * The `--help` path never imports the AWS SDK and never touches AWS, so usage
 * can be checked without credentials.
 *
 * Usage:
 *   scripts/estimate-run-cost.mjs --run <runId> [--run <runId> ...] [options]
 *   scripts/estimate-run-cost.mjs <runId> [<runId> ...] [options]
 *
 * Options:
 *   --run <id>        A run ID to estimate. Repeatable. Positional run IDs
 *                      (bare args) are also accepted.
 *   --region <r>      AWS region (or $AWS_REGION / $COST_REGION). Required.
 *   --json            Emit machine-readable JSON instead of the text readout.
 *                      (The disclaimer is still included as a field.)
 *   --step-seconds <n> DYNAMIC-storage usage query resolution, clamped to >= 30
 *                      (default 30).
 *   --help, -h        Print this help and exit. Never imports the SDK.
 *
 * Examples:
 *   scripts/estimate-run-cost.mjs --help
 *   scripts/estimate-run-cost.mjs --run 1234567 --region us-east-1
 *   scripts/estimate-run-cost.mjs 1234567 7654321 --region us-east-1 --json
 */

import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Dependency resolution.
//
// This script's third-party deps (the AWS SDK clients + signing libs) may live
// in EITHER of two layouts, so the same file works both ways:
//   (a) STANDALONE package: a `node_modules` next to this script (its own
//       package.json pins the deps) — the zip handed to another developer; or
//   (b) IN-REPO: the repo's `ingest/node_modules` (the ingest package pins the
//       same versions).
// Resolution tries (a) first, then (b). Each module is imported by absolute
// file URL, so the script runs from ANY working directory.
//
// `--help` and all arg-validation paths run BEFORE any importSdk() call, so
// usage can still be checked with no SDK installed and no credentials.
// ---------------------------------------------------------------------------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INGEST_DIR = path.resolve(SCRIPT_DIR, '..', 'ingest');

// Candidate require roots, in priority order: this script's own dir (standalone
// package), then the ingest package (in-repo). A require is anchored at each
// directory's package.json so bare specifiers resolve against that dir's
// node_modules.
const RESOLVE_ROOTS = [
  { label: 'standalone', dir: SCRIPT_DIR },
  { label: 'ingest', dir: INGEST_DIR },
];
const requirers = RESOLVE_ROOTS.map((root) => {
  // Anchor on <dir>/package.json even if it does not exist; createRequire only
  // needs a path to anchor relative resolution, and resolve() will simply fail
  // (caught below) when the dir has no node_modules.
  return {
    ...root,
    require: createRequire(pathToFileURL(path.join(root.dir, 'package.json'))),
  };
});

/** Resolve a specifier to an absolute path from the first root that has it, or null. */
function resolveFromRoots(specifier) {
  for (const r of requirers) {
    try {
      return r.require.resolve(specifier);
    } catch {
      // try next root
    }
  }
  return null;
}

/** Resolve+import an SDK module from the first available resolve root. */
async function importSdk(specifier) {
  const resolved = resolveFromRoots(specifier);
  if (resolved === null) {
    throw new Error(
      `Could not load "${specifier}" from any of: ` +
        RESOLVE_ROOTS.map((r) => `${r.dir}/node_modules`).join(', ') +
        `\n  Install dependencies first:  npm install  (in this script's directory, ` +
        `or in the repo's ingest/ package).`,
    );
  }
  return import(pathToFileURL(resolved).href);
}

// ---------------------------------------------------------------------------
// Defensive preflight.
//
// Every third-party module the script needs at runtime, resolved from the
// ingest package. Checking all of them UP FRONT (before any AWS call) lets us
// report every missing dependency at once with a single actionable install
// command, instead of failing partway through on the first missing import.
// ---------------------------------------------------------------------------
const REQUIRED_MODULES = [
  '@aws-sdk/client-omics', // GetRun / ListRunTasks / ListRunsInBatch
  '@aws-sdk/client-pricing', // GetProducts (rate card)
  '@smithy/signature-v4', // SigV4 signing for the DYNAMIC-storage PromQL POST
  '@aws-crypto/sha256-js', // SigV4 hash dependency
  '@aws-sdk/credential-provider-node', // credentials for signing + SDK clients
];

/** The minimum Node major version (Node 20+, matching the repo toolchain). */
const MIN_NODE_MAJOR = 20;

/**
 * Verify the runtime has everything the script needs BEFORE doing any AWS work:
 *   1. Node >= MIN_NODE_MAJOR (the script relies on global `fetch`, which is
 *      stable from Node 18+, and the repo targets Node 20).
 *   2. Every entry in REQUIRED_MODULES resolves from `ingest/node_modules`.
 *
 * Collects ALL problems and returns them as a list of human-readable strings
 * (empty => all good), so the caller can print one consolidated error with the
 * exact remediation rather than throwing on the first failure.
 */
function preflightDependencies() {
  const problems = [];

  // 1. Node version.
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    problems.push(
      `Node ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node}). ` +
        `This script uses the global fetch() API and targets the repo's Node 20 toolchain.`,
    );
  }

  // 2. global fetch must exist (defensive: present on Node 18+, but a custom
  //    build or a very old runtime could lack it).
  if (typeof fetch !== 'function') {
    problems.push(
      'global fetch() is unavailable in this runtime; it is required for the ' +
        'DYNAMIC-storage CloudWatch query. Upgrade to Node 18+ (ideally Node 20).',
    );
  }

  // 3. Required modules resolvable from one of the resolve roots (standalone
  //    package's own node_modules, or the repo's ingest/node_modules).
  const missing = [];
  for (const specifier of REQUIRED_MODULES) {
    if (resolveFromRoots(specifier) === null) {
      missing.push(specifier);
    }
  }
  if (missing.length > 0) {
    const roots = RESOLVE_ROOTS.map((r) => `    - ${r.dir}/node_modules`).join('\n');
    problems.push(
      `Missing ${missing.length} required module(s). Searched:\n` +
        roots +
        `\n  Not found:\n` +
        missing.map((m) => `    - ${m}`).join('\n') +
        `\n  Install dependencies with 'npm install' in this script's directory ` +
        `(standalone package) or in the repo's ingest/ package.`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The estimate disclaimer. Printed prominently with EVERY readout (text + JSON)
// and in --help. This is the required "estimates do not account for discounts"
// warning.
// ---------------------------------------------------------------------------
const DISCLAIMER_LINES = [
  'ESTIMATE ONLY — NOT A BILL.',
  'Figures are LIST-PRICE estimates: measured run/task runtime multiplied by the',
  'published AWS HealthOmics On-Demand Price List for the selected region.',
  'They DO NOT reflect any discounts, credits, Savings Plans, Reserved pricing,',
  'private pricing, taxes, or free-tier allowances, and will differ from your',
  'actual AWS bill. Unavailable inputs are shown as "unavailable" and are never',
  'counted as zero; a total marked PARTIAL omits those unpriced line items.',
];

function disclaimerBanner() {
  const width = Math.max(...DISCLAIMER_LINES.map((l) => l.length));
  const bar = '!'.repeat(width + 4);
  const body = DISCLAIMER_LINES.map((l) => `! ${l.padEnd(width)} !`).join('\n');
  return `${bar}\n${body}\n${bar}`;
}

const HELP = process.argv.includes('--help') || process.argv.includes('-h');

const HELP_TEXT = `
estimate-run-cost.mjs — standalone, UI-free per-run workflow cost ESTIMATOR.

${disclaimerBanner()}

Given one or more HealthOmics run IDs, reproduces the dashboard's per-run cost
estimate using ONLY AWS APIs (omics:GetRun, omics:ListRunTasks,
pricing:GetProducts, and the CloudWatch PromQL query_range API for DYNAMIC
storage). It never reads DynamoDB and never uses the GraphQL/UI path.

Usage:
  scripts/estimate-run-cost.mjs --run <runId> [--run <runId> ...] [options]
  scripts/estimate-run-cost.mjs <runId> [<runId> ...] [options]

Options:
  --run <id>          A run ID to estimate. Repeatable. Bare positional run IDs
                      are also accepted.
  --batch-id <id>     Estimate every run in this HealthOmics batch (resolved via
                      omics:ListRunsInBatch). Repeatable; combinable with --run.
  --region <r>        AWS region (or $AWS_REGION / $COST_REGION). Required.
  --json              Emit machine-readable JSON instead of the text readout.
  --step-seconds <n>  DYNAMIC-storage usage query resolution, clamped to >= 30
                      (default 30).
  --help, -h          Print this help and exit. Never imports the SDK.

Examples:
  scripts/estimate-run-cost.mjs --help
  scripts/estimate-run-cost.mjs --run 1234567 --region us-east-1
  scripts/estimate-run-cost.mjs --batch-id 3695724 --region us-east-1
  scripts/estimate-run-cost.mjs 1234567 7654321 --region us-east-1 --json
`;

if (HELP) {
  process.stdout.write(`${HELP_TEXT}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Arg parsing. Supports repeated --run and bare positional run IDs.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const runIds = [];
  const batchIds = [];
  let region = process.env.COST_REGION ?? process.env.AWS_REGION ?? '';
  let json = false;
  let stepSeconds = 30;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--run requires a run ID value');
      }
      runIds.push(value);
      i += 1;
    } else if (arg === '--batch-id') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--batch-id requires a batch ID value');
      }
      batchIds.push(value);
      i += 1;
    } else if (arg === '--region') {
      region = argv[i + 1] ?? region;
      i += 1;
    } else if (arg === '--step-seconds') {
      stepSeconds = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      // Bare positional => a run ID.
      runIds.push(arg);
    }
  }

  return { runIds, batchIds, region, json, stepSeconds };
}

// ===========================================================================
// Pure cost math (ported verbatim in behavior from ingest/src/cost/estimate.ts).
// No I/O; returns null — never a fabricated 0 — when a value cannot be computed.
// ===========================================================================

const HOUR_MS = 60 * 60 * 1000;
const COMPUTE_UNIT = 'Instance-hrs';
const STORAGE_UNIT = 'GB-Hours';
const STORAGE_FAMILY_STATIC = 'Run Storage';
const STORAGE_FAMILY_DYNAMIC = 'Dynamic Run Storage';

/**
 * One minute, expressed in hours (1/60). AWS HealthOmics bills compute per task
 * with a one-minute minimum task duration charge — each task is billed for at
 * least one minute even if it ran for less (see "Run optimization for a
 * private HealthOmics workflow",
 * https://docs.aws.amazon.com/omics/latest/dev/workflows-run-optimize.html).
 * Mirrors `ONE_MINUTE_HOURS` in ingest/src/cost/estimate.ts so both estimators
 * agree.
 */
const ONE_MINUTE_HOURS = 1 / 60;

/** Wall-clock hours between two ISO timestamps; null if missing/unparseable/inverted. */
function instanceHours(startedAt, stoppedAt) {
  if (startedAt == null || stoppedAt == null) return null;
  const start = Date.parse(startedAt);
  const stop = Date.parse(stoppedAt);
  if (Number.isNaN(start) || Number.isNaN(stop)) return null;
  if (stop < start) return null;
  return (stop - start) / HOUR_MS;
}

/**
 * Group tasks by instanceType, summing BILLED instance-hours; count the
 * unpriceable.
 *
 * Each task's raw measured hours are floored to `ONE_MINUTE_HOURS` (the
 * one-minute-minimum task duration charge) PER TASK, before summing into
 * `byInstanceType` — two sub-minute tasks aggregate to 2 x ONE_MINUTE_HOURS,
 * not a single floor applied to their combined raw duration. A task with no
 * usable runtime is still excluded (not floored); a task missing its
 * instanceType is still counted separately.
 */
function aggregateComputeHours(tasks) {
  const byInstanceType = new Map();
  let missingInstanceTypeCount = 0;
  let excludedNoRuntimeCount = 0;

  for (const task of tasks) {
    const hours = instanceHours(task.startedAt, task.stoppedAt);
    if (hours === null) {
      excludedNoRuntimeCount += 1;
      continue;
    }
    const type =
      typeof task.instanceType === 'string' && task.instanceType.length > 0
        ? task.instanceType
        : null;
    if (type === null) {
      missingInstanceTypeCount += 1;
      continue;
    }
    const billedHours = Math.max(hours, ONE_MINUTE_HOURS);
    byInstanceType.set(type, (byInstanceType.get(type) ?? 0) + billedHours);
  }

  return { byInstanceType, missingInstanceTypeCount, excludedNoRuntimeCount };
}

function bytesToGb(bytes) {
  return bytes / 1e9;
}

/** Trapezoidal time-integral of a {timestamp(ms), value(bytes)} series to GB-hours. */
function trapezoidalGbHours(points) {
  if (points.length === 0) return null;
  if (points.length === 1) return 0;
  const sorted = [...points].sort((a, b) => a.timestamp - b.timestamp);
  let gbHours = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const deltaHours = (cur.timestamp - prev.timestamp) / HOUR_MS;
    const avgGb = (bytesToGb(prev.value) + bytesToGb(cur.value)) / 2;
    gbHours += avgGb * deltaHours;
  }
  return gbHours;
}

/** Assemble compute line items from aggregated hours + rate map. */
function computeComputeLineItems(agg, rateMap) {
  const items = [];
  const excludedSuffix =
    agg.excludedNoRuntimeCount > 0
      ? ` (${agg.excludedNoRuntimeCount} task${
          agg.excludedNoRuntimeCount === 1 ? '' : 's'
        } excluded for no measured runtime)`
      : '';

  const instanceTypes = [...agg.byInstanceType.keys()].sort();
  for (const instanceType of instanceTypes) {
    const hours = agg.byInstanceType.get(instanceType) ?? 0;
    const rate = rateMap[instanceType];
    if (rate === undefined) {
      items.push({
        category: 'COMPUTE',
        usageType: `Compute (${instanceType})`,
        resourceType: instanceType,
        quantity: hours,
        unit: COMPUTE_UNIT,
        ratePerUnit: null,
        estimatedCost: null,
        available: false,
        unavailableReason: `No published rate for ${instanceType}${excludedSuffix}`,
      });
      continue;
    }
    items.push({
      category: 'COMPUTE',
      usageType: `Compute (${instanceType})`,
      resourceType: instanceType,
      quantity: hours,
      unit: COMPUTE_UNIT,
      ratePerUnit: rate.pricePerUnit,
      estimatedCost: hours * rate.pricePerUnit,
      available: true,
      unavailableReason: excludedSuffix === '' ? null : excludedSuffix.trim(),
    });
  }

  if (agg.missingInstanceTypeCount > 0) {
    items.push({
      category: 'COMPUTE',
      usageType: 'Compute (instance type unavailable)',
      resourceType: null,
      quantity: null,
      unit: COMPUTE_UNIT,
      ratePerUnit: null,
      estimatedCost: null,
      available: false,
      unavailableReason: `${agg.missingInstanceTypeCount} task${
        agg.missingInstanceTypeCount === 1 ? '' : 's'
      } with no captured instance type`,
    });
  }

  return items;
}

/** Assemble the single storage line item (STATIC capacity×hours, DYNAMIC integrated series). */
function computeStorageLineItem(args) {
  const { storageType, storageCapacityGb, runHours, filesystemPoints, rateMap } = args;

  const normalized = typeof storageType === 'string' ? storageType.toUpperCase() : null;
  const family =
    normalized === 'DYNAMIC'
      ? STORAGE_FAMILY_DYNAMIC
      : normalized === 'STATIC'
        ? STORAGE_FAMILY_STATIC
        : null;

  if (family === null) {
    return {
      category: 'STORAGE',
      usageType: 'Run Storage',
      resourceType: null,
      quantity: null,
      unit: STORAGE_UNIT,
      ratePerUnit: null,
      estimatedCost: null,
      available: false,
      unavailableReason:
        storageType == null
          ? 'Run storage type unavailable'
          : `Unrecognized storage type: ${storageType}`,
    };
  }

  let quantity;
  let quantityReason = null;
  if (family === STORAGE_FAMILY_STATIC) {
    if (
      storageCapacityGb == null ||
      !Number.isFinite(storageCapacityGb) ||
      runHours == null ||
      !Number.isFinite(runHours)
    ) {
      quantity = null;
      quantityReason = 'Static storage capacity or run duration unavailable';
    } else {
      quantity = storageCapacityGb * runHours;
    }
  } else {
    quantity = filesystemPoints == null ? null : trapezoidalGbHours(filesystemPoints);
    if (quantity === null) {
      quantityReason = 'Dynamic run storage usage series unavailable';
    }
  }

  const rate = rateMap[family];

  if (quantity === null) {
    return {
      category: 'STORAGE',
      usageType: family,
      resourceType: family,
      quantity: null,
      unit: STORAGE_UNIT,
      ratePerUnit: rate?.pricePerUnit ?? null,
      estimatedCost: null,
      available: false,
      unavailableReason: quantityReason,
    };
  }

  if (rate === undefined) {
    return {
      category: 'STORAGE',
      usageType: family,
      resourceType: family,
      quantity,
      unit: STORAGE_UNIT,
      ratePerUnit: null,
      estimatedCost: null,
      available: false,
      unavailableReason: `No published rate for ${family}`,
    };
  }

  return {
    category: 'STORAGE',
    usageType: family,
    resourceType: family,
    quantity,
    unit: STORAGE_UNIT,
    ratePerUnit: rate.pricePerUnit,
    estimatedCost: quantity * rate.pricePerUnit,
    available: true,
    unavailableReason: null,
  };
}

/** Sum available line items; mark partial when any is unavailable. */
function assembleEstimate(runId, lineItems, currency, effectiveDate) {
  const available = lineItems.filter((item) => item.available);
  const total =
    available.length === 0
      ? null
      : available.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0);
  const partial = lineItems.some((item) => !item.available);
  return { runId, lineItems, total, currency, effectiveDate, partial, error: null };
}

function costError(runId, message) {
  return {
    runId,
    lineItems: [],
    total: null,
    currency: null,
    effectiveDate: null,
    partial: false,
    error: message,
  };
}

// ===========================================================================
// AWS I/O (dynamically imported so --help needs no SDK/credentials).
// ===========================================================================

/** Fetch the region's AmazonOmics Private-workflow On-Demand rate map via pricing:GetProducts. */
async function fetchRateMap(region) {
  const { PricingClient, GetProductsCommand } = await importSdk('@aws-sdk/client-pricing');
  // The Price List API is served out of us-east-1 / ap-south-1 only; the region
  // being PRICED is passed as the regionCode filter, not the client region.
  const client = new PricingClient({ region: 'us-east-1' });

  const STORAGE_RESOURCE_TYPES = new Set(['Dynamic Run Storage', 'Run Storage']);
  const rates = {};
  let nextToken;

  const asRecord = (v) => (typeof v === 'object' && v !== null ? v : null);
  const firstValue = (v) => {
    const r = asRecord(v);
    if (r === null) return null;
    const keys = Object.keys(r);
    return keys.length > 0 ? r[keys[0]] : null;
  };

  do {
    const response = await client.send(
      new GetProductsCommand({
        ServiceCode: 'AmazonOmics',
        Filters: [
          { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
          { Type: 'TERM_MATCH', Field: 'workflowType', Value: 'Private' },
        ],
        NextToken: nextToken,
      }),
    );

    for (const raw of response.PriceList ?? []) {
      if (raw == null) continue;
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        continue;
      }
      const root = asRecord(parsed);
      const product = asRecord(root?.product);
      const attributes = asRecord(product?.attributes);
      if (product === null || attributes === null) continue;
      if (product.productFamily !== 'Compute') continue;

      const resourceType = attributes.resourceType;
      if (typeof resourceType !== 'string' || resourceType.trim() === '') continue;

      const terms = asRecord(root?.terms);
      const onDemand = firstValue(terms?.OnDemand);
      const priceDimension = firstValue(asRecord(onDemand)?.priceDimensions);
      const dimension = asRecord(priceDimension);
      if (dimension === null) continue;

      const unit = dimension.unit;
      if (typeof unit !== 'string') continue;

      const isStorage = STORAGE_RESOURCE_TYPES.has(resourceType);
      const isInScope = isStorage ? unit === STORAGE_UNIT : unit === COMPUTE_UNIT;
      if (!isInScope) continue;

      const pricePerUnitRaw = asRecord(dimension.pricePerUnit)?.USD;
      if (typeof pricePerUnitRaw !== 'string' && typeof pricePerUnitRaw !== 'number') continue;
      const pricePerUnit = Number(pricePerUnitRaw);
      if (!Number.isFinite(pricePerUnit)) continue;

      rates[resourceType] = { pricePerUnit, unit };
    }

    nextToken = response.NextToken ?? undefined;
  } while (nextToken !== undefined);

  return { rates, currency: 'USD' };
}

/** Resolve the run's storage fields + wall-clock window via omics:GetRun. */
async function resolveRunContext(omicsClient, GetRunCommand, runId) {
  try {
    const run = await omicsClient.send(new GetRunCommand({ id: runId }));
    if (!(run.startTime instanceof Date)) {
      return { ok: false, errorMessage: `GetRun did not return a startTime for run "${runId}"` };
    }
    const windowStart = run.startTime.toISOString();
    const windowEnd =
      run.stopTime instanceof Date ? run.stopTime.toISOString() : new Date().toISOString();
    return {
      ok: true,
      context: {
        storageType: typeof run.storageType === 'string' ? run.storageType : null,
        storageCapacityGb: typeof run.storageCapacity === 'number' ? run.storageCapacity : null,
        windowStart,
        windowEnd,
        runHours: instanceHours(windowStart, windowEnd),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage: `GetRun failed for run "${runId}": ${message}`,
    };
  }
}

/** Resolve all run IDs belonging to a batch via omics:ListRunsInBatch (paginated). */
async function resolveBatchRunIds(omicsClient, ListRunsInBatchCommand, batchId) {
  const ids = [];
  let startingToken;
  do {
    const res = await omicsClient.send(
      new ListRunsInBatchCommand({ batchId, startingToken }),
    );
    for (const r of res.items ?? res.runs ?? []) {
      const id = r.runId ?? r.id;
      if (id != null) ids.push(String(id));
    }
    startingToken = res.nextToken ?? undefined;
  } while (startingToken !== undefined);
  return ids;
}

/** Load the run's tasks via omics:ListRunTasks (paginated), returning the cost-math fields. */
async function loadRunTasks(omicsClient, ListRunTasksCommand, runId) {
  const tasks = [];
  let startingToken;
  do {
    const result = await omicsClient.send(
      new ListRunTasksCommand({ id: runId, startingToken }),
    );
    for (const item of result.items ?? []) {
      tasks.push({
        instanceType: typeof item.instanceType === 'string' ? item.instanceType : null,
        startedAt: item.startTime instanceof Date ? item.startTime.toISOString() : null,
        stoppedAt: item.stopTime instanceof Date ? item.stopTime.toISOString() : null,
      });
    }
    startingToken = result.nextToken ?? undefined;
  } while (startingToken !== undefined);
  return tasks;
}

/** Build a well-formed PromQL selector referencing a dotted metric via __name__, scoped to runId. */
function buildSelector(metricName, runId) {
  const q = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `{__name__=${q(metricName)}, "@resource.aws.omics.run.id"=${q(runId)}}`;
}

/** SigV4-sign (service `monitoring`) and POST a query_range request for the DYNAMIC usage series. */
async function fetchRunFilesystemUsage(runId, window, region, stepSeconds) {
  const { SignatureV4 } = await importSdk('@smithy/signature-v4');
  const { Sha256 } = await importSdk('@aws-crypto/sha256-js');
  const { defaultProvider } = await importSdk('@aws-sdk/credential-provider-node');

  const host = `monitoring.${region}.amazonaws.com`;
  const path = '/api/v1/query_range';
  const step = String(
    typeof stepSeconds === 'number' && Number.isFinite(stepSeconds) && stepSeconds >= 30
      ? Math.floor(stepSeconds)
      : 30,
  );

  const body = new URLSearchParams();
  body.set('query', buildSelector('aws.omics.run.filesystem.usage', runId));
  body.set('start', window.start);
  body.set('end', window.end);
  body.set('step', step);
  const bodyStr = body.toString();

  const signer = new SignatureV4({
    service: 'monitoring',
    region,
    sha256: Sha256,
    credentials: defaultProvider(),
  });
  const signed = await signer.sign({
    method: 'POST',
    protocol: 'https:',
    hostname: host,
    path,
    headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
    body: bodyStr,
  });

  const response = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: signed.headers,
    body: bodyStr,
  });

  // HTTP-level or Prometheus-level failure => unavailable (never fabricate).
  if (!response.ok) return null;
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    return null;
  }
  if (!envelope || envelope.status === 'error') return null;

  const results = envelope.data?.result ?? [];
  // Run-level series carry only the run id (no task id label). Collect their points.
  const points = [];
  for (const series of results) {
    const labels = series.metric ?? {};
    const taskId = labels['@resource.aws.omics.run.task.id'] ?? null;
    if (taskId != null) continue; // task-level series — skip; we want run-level
    for (const [unixSeconds, valueStr] of series.values ?? []) {
      const value = Number(valueStr);
      if (!Number.isFinite(value)) continue;
      points.push({ timestamp: Math.round(unixSeconds * 1000), value });
    }
  }
  if (points.length === 0) return null;
  return points;
}

/** Full per-run estimate orchestration (AWS APIs only). */
async function estimateRun(deps, runId, region, stepSeconds, rateCard) {
  const { omicsClient, GetRunCommand, ListRunTasksCommand } = deps;

  const resolvedRun = await resolveRunContext(omicsClient, GetRunCommand, runId);
  if (!resolvedRun.ok) return costError(runId, resolvedRun.errorMessage);
  const run = resolvedRun.context;

  let tasks;
  try {
    tasks = await loadRunTasks(omicsClient, ListRunTasksCommand, runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return costError(runId, `Failed to list tasks for run "${runId}": ${message}`);
  }

  const rateMap = rateCard.status === 'ok' ? rateCard.rates : {};
  const currency = rateCard.status === 'ok' ? rateCard.currency : null;
  const effectiveDate = rateCard.status === 'ok' ? rateCard.effectiveDate : null;

  const computeItems = computeComputeLineItems(aggregateComputeHours(tasks), rateMap);

  const isDynamic =
    typeof run.storageType === 'string' && run.storageType.toUpperCase() === 'DYNAMIC';
  let filesystemPoints = null;
  if (isDynamic) {
    try {
      filesystemPoints = await fetchRunFilesystemUsage(
        runId,
        { start: run.windowStart, end: run.windowEnd },
        region,
        stepSeconds,
      );
    } catch {
      filesystemPoints = null;
    }
  }

  const storageItem = computeStorageLineItem({
    storageType: run.storageType,
    storageCapacityGb: run.storageCapacityGb,
    runHours: run.runHours,
    filesystemPoints,
    rateMap,
  });

  return assembleEstimate(runId, [...computeItems, storageItem], currency, effectiveDate);
}

// ===========================================================================
// Readout formatting.
// ===========================================================================

function fmtMoney(value, currency) {
  if (value == null) return 'unavailable';
  const cur = currency ?? 'USD';
  return `${cur} ${value.toFixed(4)}`;
}

function fmtNum(value) {
  if (value == null) return '—';
  return value.toFixed(4);
}

function renderTextReadout(estimate) {
  const lines = [];
  lines.push(`Run: ${estimate.runId}`);
  if (estimate.error) {
    lines.push(`  ERROR: ${estimate.error}`);
    return lines.join('\n');
  }
  if (estimate.effectiveDate) {
    lines.push(`  Rate card effective date: ${estimate.effectiveDate} (${estimate.currency ?? 'USD'})`);
  } else {
    lines.push('  Rate card: UNAVAILABLE (no published rates applied)');
  }
  lines.push('  Line items:');
  for (const item of estimate.lineItems) {
    const status = item.available ? 'OK' : 'UNAVAILABLE';
    lines.push(`    - [${status}] ${item.usageType}`);
    lines.push(
      `        qty=${fmtNum(item.quantity)} ${item.unit}` +
        `  rate=${item.ratePerUnit == null ? '—' : item.ratePerUnit}` +
        `  cost=${fmtMoney(item.estimatedCost, estimate.currency)}`,
    );
    if (!item.available && item.unavailableReason) {
      lines.push(`        reason: ${item.unavailableReason}`);
    }
  }
  const partialTag = estimate.partial ? '  [PARTIAL — some line items unavailable]' : '';
  lines.push(`  TOTAL (estimate): ${fmtMoney(estimate.total, estimate.currency)}${partialTag}`);
  return lines.join('\n');
}

// ===========================================================================
// Aggregate profiling across a group of runs.
//
// Follows the Reports view's two conventions:
//   - statistics reported are mean, median, and p90 (plus count/sum/min/max);
//   - AVAILABILITY HONESTY: each statistic is computed ONLY over the runs where
//     that value was actually available (never zero-filled), and carries an
//     explicit "N of M runs" denominator.
// ===========================================================================

/** Arithmetic mean of a non-empty numeric array; null for empty. */
function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Linear-interpolation percentile (same method as a typical "p90"): sorts the
 * values and interpolates at rank p*(n-1). `p` in [0,1]. Null for empty.
 */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** median = p50. */
function median(values) {
  return percentile(values, 0.5);
}

/**
 * Compute the stat block for one metric over the group. `values` are only the
 * AVAILABLE observations (callers must exclude unavailable/null ones); `total`
 * is the number of runs considered, so the readout can show "N of M".
 */
function statBlock(values, total) {
  return {
    availableCount: values.length,
    totalCount: total,
    sum: values.length === 0 ? null : values.reduce((a, b) => a + b, 0),
    mean: mean(values),
    median: median(values),
    p90: percentile(values, 0.9),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

/**
 * Build the aggregate profile across all successfully-estimated runs.
 *
 * Runs with a hard `error` (the whole estimate failed) are excluded from the run
 * population entirely (counted separately as `erroredRuns`), since they produced
 * no comparable estimate. Among the remaining runs:
 *   - `runTotal` stats are over runs whose `total` is non-null (a run with no
 *     available line items has `total === null` and is excluded from the mean,
 *     honestly reported via the N-of-M denominator);
 *   - per-component stats (keyed by `usageType`, e.g. each instance type and
 *     "Dynamic Run Storage") are over the runs where THAT component's line item
 *     was `available` — never zero-filled for runs where it was unavailable.
 */
function buildProfile(estimates) {
  const errored = estimates.filter((e) => e.error != null);
  const scored = estimates.filter((e) => e.error == null);
  const M = scored.length;

  // Run-total stats over runs with a non-null total.
  const runTotals = scored.map((e) => e.total).filter((t) => t != null);

  // Per-component stats, keyed by usageType, over available line items only.
  const componentValues = new Map(); // usageType -> number[]
  const componentUnavailable = new Map(); // usageType -> count of runs where unavailable
  for (const est of scored) {
    const seen = new Set();
    for (const item of est.lineItems) {
      seen.add(item.usageType);
      if (item.available && item.estimatedCost != null) {
        if (!componentValues.has(item.usageType)) componentValues.set(item.usageType, []);
        componentValues.get(item.usageType).push(item.estimatedCost);
      } else {
        componentUnavailable.set(
          item.usageType,
          (componentUnavailable.get(item.usageType) ?? 0) + 1,
        );
      }
    }
  }

  const components = [...componentValues.keys()]
    .sort()
    .map((usageType) => ({
      usageType,
      stats: statBlock(componentValues.get(usageType) ?? [], M),
    }));

  return {
    runsConsidered: M,
    erroredRuns: errored.map((e) => ({ runId: e.runId, error: e.error })),
    partialRuns: scored.filter((e) => e.partial).map((e) => e.runId),
    runTotal: statBlock(runTotals, M),
    components,
  };
}

/** Render one stat block as an aligned, N-of-M-honest text block. */
function renderStatBlock(label, stats, currency) {
  const nOfM = `${stats.availableCount} of ${stats.totalCount} runs`;
  if (stats.availableCount === 0) {
    return `  ${label}: unavailable (0 of ${stats.totalCount} runs had this value)`;
  }
  const m = (v) => fmtMoney(v, currency);
  return [
    `  ${label}  [${nOfM}]`,
    `      sum=${m(stats.sum)}  mean=${m(stats.mean)}  median=${m(stats.median)}  p90=${m(stats.p90)}`,
    `      min=${m(stats.min)}  max=${m(stats.max)}`,
  ].join('\n');
}

/** Render the whole aggregate profile for the text readout. */
function renderProfile(profile, currency) {
  const out = [];
  out.push('════════════════════════════════════════════════════════════════════');
  out.push(`COST PROFILE across ${profile.runsConsidered} estimated run(s)`);
  out.push('════════════════════════════════════════════════════════════════════');
  out.push(renderStatBlock('Run total (estimate)', profile.runTotal, currency));
  out.push('');
  out.push('  Per-component cost (each stat over the runs where it was available):');
  for (const comp of profile.components) {
    out.push(renderStatBlock(`  • ${comp.usageType}`, comp.stats, currency));
  }
  if (profile.partialRuns.length > 0) {
    out.push('');
    out.push(
      `  Partial runs (some line item unavailable): ${profile.partialRuns.length} — ${profile.partialRuns.join(', ')}`,
    );
  }
  if (profile.erroredRuns.length > 0) {
    out.push(
      `  Errored runs (excluded from stats): ${profile.erroredRuns.length} — ${profile.erroredRuns
        .map((e) => e.runId)
        .join(', ')}`,
    );
  }
  return out.join('\n');
}

// ===========================================================================
// Main.
// ===========================================================================

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${HELP_TEXT}\n`);
    process.exit(2);
  }

  if (args.runIds.length === 0 && args.batchIds.length === 0) {
    process.stderr.write(
      `No runs given. Provide --run <id>, a positional run ID, or --batch-id <id>.\n\n${HELP_TEXT}\n`,
    );
    process.exit(2);
  }
  if (!args.region) {
    process.stderr.write('Region is required (--region or $AWS_REGION / $COST_REGION).\n');
    process.exit(2);
  }

  // Defensive preflight: verify Node version + all required modules are present
  // BEFORE any AWS work, reporting every problem at once with the exact fix.
  const problems = preflightDependencies();
  if (problems.length > 0) {
    process.stderr.write(
      `Cannot run — ${problems.length} dependency problem(s) detected:\n\n` +
        problems.map((p, i) => `${i + 1}. ${p}`).join('\n\n') +
        '\n',
    );
    process.exit(3);
  }

  // Import the omics SDK once; share the client across runs.
  const { OmicsClient, GetRunCommand, ListRunTasksCommand, ListRunsInBatchCommand } =
    await importSdk('@aws-sdk/client-omics');
  const omicsClient = new OmicsClient({ region: args.region });
  const deps = { omicsClient, GetRunCommand, ListRunTasksCommand };

  // Resolve any --batch-id(s) into run IDs via omics:ListRunsInBatch, then merge
  // with explicitly-given run IDs (de-duplicated, preserving first-seen order).
  const resolved = [...args.runIds];
  for (const batchId of args.batchIds) {
    let batchRunIds;
    try {
      batchRunIds = await resolveBatchRunIds(omicsClient, ListRunsInBatchCommand, batchId);
    } catch (err) {
      process.stderr.write(
        `Failed to list runs for batch "${batchId}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    if (batchRunIds.length === 0) {
      process.stderr.write(`Warning: batch "${batchId}" contained no runs.\n`);
    }
    resolved.push(...batchRunIds);
  }
  const runIds = [...new Set(resolved)];

  if (runIds.length === 0) {
    process.stderr.write('No runs to estimate after resolving the given batch/run IDs.\n');
    process.exit(2);
  }

  // Fetch the rate card ONCE (region-wide) and reuse across all runs.
  let rateCard;
  try {
    const fetched = await fetchRateMap(args.region);
    rateCard =
      Object.keys(fetched.rates).length === 0
        ? { status: 'unavailable', reason: `Price List returned no usable rates for region "${args.region}"` }
        : {
            status: 'ok',
            rates: fetched.rates,
            currency: fetched.currency,
            effectiveDate: new Date().toISOString().slice(0, 10),
          };
  } catch (err) {
    rateCard = { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }

  const estimates = [];
  for (const runId of runIds) {
    // Sequential to stay well within API rate limits for a group of runs.
    const estimate = await estimateRun(deps, runId, args.region, args.stepSeconds, rateCard);
    estimates.push(estimate);
  }

  // Combined total across all runs (sum of each run's available total).
  const totals = estimates.map((e) => e.total).filter((t) => t != null);
  const combinedTotal = totals.length === 0 ? null : totals.reduce((a, b) => a + b, 0);
  const anyPartial = estimates.some((e) => e.partial || e.error != null || e.total == null);
  const currency =
    estimates.find((e) => e.currency != null)?.currency ?? (rateCard.status === 'ok' ? rateCard.currency : 'USD');

  // Aggregate cost profile across the group (mean/median/p90/etc, N-of-M honest).
  const profile = buildProfile(estimates);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          disclaimer: DISCLAIMER_LINES.join(' '),
          region: args.region,
          rateCardStatus: rateCard.status,
          estimates,
          combinedTotal,
          combinedPartial: anyPartial,
          currency,
          profile,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  // Text readout: disclaimer FIRST (prominent), then per-run, then combined, then disclaimer AGAIN.
  const out = [];
  out.push(disclaimerBanner());
  out.push('');
  out.push(`Region: ${args.region}    Runs: ${estimates.length}    Rate card: ${rateCard.status.toUpperCase()}`);
  if (rateCard.status !== 'ok') {
    out.push(`  (rate card unavailable: ${rateCard.reason} — compute/storage shown unpriced)`);
  }
  out.push('');
  for (const estimate of estimates) {
    out.push(renderTextReadout(estimate));
    out.push('');
  }
  if (estimates.length > 1) {
    const partialTag = anyPartial ? '  [PARTIAL — some runs/line items unavailable]' : '';
    out.push(`COMBINED TOTAL (estimate, ${estimates.length} runs): ${fmtMoney(combinedTotal, currency)}${partialTag}`);
    out.push('');
    out.push(renderProfile(profile, currency));
    out.push('');
  }
  out.push(disclaimerBanner());
  process.stdout.write(`${out.join('\n')}\n`);
}

// Only run the CLI when executed directly (not when imported for testing).
// Compare REAL paths so a symlinked invocation (e.g. a bin shim, or a path under
// a symlinked temp dir) still counts as a direct run rather than silently
// skipping main().
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const real = (p) => {
      try {
        return realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    return real(thisFile) === real(entry);
  } catch {
    // Fall back to the direct URL comparison if anything above is unavailable.
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}

// Exports for unit testing the pure cost math + readout (no AWS, no CLI).
export {
  instanceHours,
  aggregateComputeHours,
  trapezoidalGbHours,
  computeComputeLineItems,
  computeStorageLineItem,
  assembleEstimate,
  costError,
  renderTextReadout,
  mean,
  median,
  percentile,
  statBlock,
  buildProfile,
  renderProfile,
  preflightDependencies,
  REQUIRED_MODULES,
  DISCLAIMER_LINES,
};
