/**
 * estimationCore.mjs — the Estimation_Core: the SINGLE SOURCE OF ESTIMATION
 * TRUTH for the Cost_Planning_Assistant. Pure, no I/O (no AWS, no console).
 *
 * Both the Planning_CLI and (indirectly, via the CLI's non-interactive mode)
 * the LLM_Skill rely on exactly this module for pricing math — neither
 * restates a rate nor re-derives the arithmetic (Req 7.5, 8.2).
 *
 * No-fabrication is structural here: a missing rate yields `available:false`
 * + a `reason`, never a numeric cost. `total` sums only `available` line
 * items; `partial` flags that the total is incomplete (Req 4.6, 6.2, 6.3,
 * 6.4, 10.3).
 */

/**
 * One minute, expressed in hours (`1/60`). AWS HealthOmics bills compute per
 * task with a one-minute minimum task duration charge (verified against
 * "Run optimization for a private HealthOmics workflow",
 * https://docs.aws.amazon.com/omics/latest/dev/workflows-run-optimize.html).
 * Same name/value as `ingest/src/cost/estimate.ts`'s `ONE_MINUTE_HOURS`,
 * applied the same way: per task, before multiplying by task count.
 */
export const ONE_MINUTE_HOURS = 1 / 60;

/** The two Price List storage-family resource-type labels (never instance types). */
const STORAGE_FAMILY_STATIC = 'Run Storage';
const STORAGE_FAMILY_DYNAMIC = 'Dynamic Run Storage';
const STORAGE_RESOURCE_TYPES = new Set([STORAGE_FAMILY_STATIC, STORAGE_FAMILY_DYNAMIC]);

const COMPUTE_UNIT = 'Instance-hrs';
const STORAGE_UNIT = 'GB-Hours';

/**
 * The user-visible statement that a Rough_Estimate is a planning estimate
 * only, never a bill (Req 5.1). Reused verbatim by `render.mjs`, the
 * non-interactive `--json` output, the README, and the LLM skill asset so
 * there is exactly one copy of this wording.
 */
export const ESTIMATE_DISCLAIMER =
  'ESTIMATE ONLY — NOT A BILL. This is a rough planning estimate computed from ' +
  'published AWS On-Demand list prices and the assumptions you supplied (runtime, ' +
  'scatter width, instance choice, storage mode and size). It excludes overhead, ' +
  'rounding, credits, discounts, Savings Plans, and Reserved pricing, and will ' +
  'differ from your actual AWS bill.';

/**
 * Join live Published_Rates to the curated Instance_Spec_Table by
 * Instance_Type, producing the menu of Instance_Options the user picks from.
 *
 * @param {Record<string, {pricePerUnit:number, unit:string}>} rateMap - the
 *   plain rates object (e.g. `fetchRateMap(...).rates`), keyed by
 *   resourceType (instance types + the two storage-family labels).
 * @param {Record<string, {vcpus:number, memoryGiB:number, gpuCount?:number, gpuMemoryGiB?:number}>} instanceSpecs
 *   - the Instance_Spec_Table (e.g. `INSTANCE_SPECS` from `instanceSpecs.mjs`).
 * @returns {Array<{
 *   instanceType: string,
 *   vcpus: number|null,
 *   memoryGiB: number|null,
 *   gpuCount?: number|null,
 *   gpuMemoryGiB?: number|null,
 *   rate: number|null,
 *   unit: string|null,
 *   specAvailable: boolean,
 *   rateAvailable: boolean,
 * }>} entries sorted by instanceType (stable, deterministic order). The two
 *   storage-family keys in `rateMap` are excluded — they are not instance
 *   types.
 */
export function buildInstanceOptions(rateMap = {}, instanceSpecs = {}) {
  const instanceTypesFromRates = Object.keys(rateMap).filter(
    (key) => !STORAGE_RESOURCE_TYPES.has(key),
  );
  const instanceTypesFromSpecs = Object.keys(instanceSpecs);
  const allInstanceTypes = new Set([...instanceTypesFromRates, ...instanceTypesFromSpecs]);

  const options = [];
  for (const instanceType of allInstanceTypes) {
    const spec = instanceSpecs[instanceType] ?? null;
    const rate = rateMap[instanceType] ?? null;

    const specAvailable = spec !== null;
    const rateAvailable = rate !== null;

    options.push({
      instanceType,
      vcpus: specAvailable ? spec.vcpus : null,
      memoryGiB: specAvailable ? spec.memoryGiB : null,
      gpuCount: specAvailable ? spec.gpuCount ?? null : null,
      gpuMemoryGiB: specAvailable ? spec.gpuMemoryGiB ?? null : null,
      rate: rateAvailable ? rate.pricePerUnit : null,
      unit: rateAvailable ? rate.unit : null,
      specAvailable,
      rateAvailable,
    });
  }

  options.sort((a, b) => a.instanceType.localeCompare(b.instanceType));
  return options;
}

/**
 * Compute the Rough_Estimate from the user's Planning_Assumptions + the live
 * rate map (pure; no I/O).
 *
 * Compute math (Req 4.1/4.2): `estimatedRuntimeHours` on each PlannedStep is a
 * PER-TASK runtime. The HealthOmics one-minute-minimum-per-task floor is
 * applied PER TASK, before multiplying by the task count (Scatter_Width):
 *   billedTaskHours = Math.max(runtimeHoursPerTask, ONE_MINUTE_HOURS)
 *   instanceHours   = billedTaskHours * scatterWidth
 *   cost            = instanceHours * rate
 *
 * Storage math (Req 4.3/4.4):
 *   gbHours = sizeGiB * runRuntimeHours
 *   family  = STATIC -> "Run Storage", DYNAMIC -> "Dynamic Run Storage"
 *   cost    = gbHours * familyRate
 *
 * @param {{
 *   steps: Array<{label:string, instanceType:string, estimatedRuntimeHours:number, scatterWidth:number}>,
 *   storage?: {mode:'STATIC'|'DYNAMIC', sizeGiB:number, runRuntimeHours:number}|null,
 * }} input
 * @param {Record<string, {pricePerUnit:number, unit:string}>} input.rateMap
 * @param {string} nowIso - ISO timestamp to record as `retrievedAt` (the CLI
 *   merges region/currency/retrievedAt from the live rate map; this pure
 *   function records whatever timestamp the caller passes so tests remain
 *   deterministic).
 * @returns {{
 *   retrievedAt: string,
 *   lineItems: Array<object>,
 *   total: number,
 *   partial: boolean,
 *   assumptions: {steps: Array<object>, storage: object|null},
 *   disclaimer: string,
 * }}
 */
export function estimate({ steps = [], storage = null, rateMap = {} }, nowIso) {
  const lineItems = [];

  for (const step of steps) {
    const { label, instanceType, estimatedRuntimeHours, scatterWidth } = step;
    const billedTaskHours = Math.max(estimatedRuntimeHours, ONE_MINUTE_HOURS);
    const minimumApplied = billedTaskHours > estimatedRuntimeHours;
    const instanceHoursValue = billedTaskHours * scatterWidth;

    const rate = rateMap[instanceType];
    if (rate === undefined) {
      lineItems.push({
        kind: 'COMPUTE',
        label,
        instanceType,
        instanceHours: instanceHoursValue,
        unit: COMPUTE_UNIT,
        rate: null,
        cost: null,
        available: false,
        minimumApplied,
        reason: `No published rate for ${instanceType}`,
      });
      continue;
    }

    lineItems.push({
      kind: 'COMPUTE',
      label,
      instanceType,
      instanceHours: instanceHoursValue,
      unit: COMPUTE_UNIT,
      rate: rate.pricePerUnit,
      cost: instanceHoursValue * rate.pricePerUnit,
      available: true,
      minimumApplied,
      reason: minimumApplied
        ? 'Billed per task at the HealthOmics one-minute-per-task minimum'
        : null,
    });
  }

  if (storage != null) {
    const { mode, sizeGiB, runRuntimeHours } = storage;
    const family = mode === 'STATIC' ? STORAGE_FAMILY_STATIC : STORAGE_FAMILY_DYNAMIC;
    const gbHours = sizeGiB * runRuntimeHours;
    const rate = rateMap[family];
    const assumptionNote =
      mode === 'DYNAMIC'
        ? 'DYNAMIC storage size is a user-supplied assumption, not a measured value'
        : null;

    if (rate === undefined) {
      lineItems.push({
        kind: 'STORAGE',
        family,
        gbHours,
        unit: STORAGE_UNIT,
        rate: null,
        cost: null,
        available: false,
        reason: `No published rate for ${family}`,
        assumptionNote,
      });
    } else {
      lineItems.push({
        kind: 'STORAGE',
        family,
        gbHours,
        unit: STORAGE_UNIT,
        rate: rate.pricePerUnit,
        cost: gbHours * rate.pricePerUnit,
        available: true,
        reason: null,
        assumptionNote,
      });
    }
  }

  const total = lineItems.reduce((sum, item) => (item.available ? sum + item.cost : sum), 0);
  const partial = lineItems.some((item) => !item.available);

  return {
    retrievedAt: nowIso,
    lineItems,
    total,
    partial,
    assumptions: { steps, storage },
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}
