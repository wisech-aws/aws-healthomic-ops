/**
 * Cost math — pure, I/O-free estimate helpers (Req 2, 3).
 *
 * This module holds the arithmetic of the run cost estimate so the eventual
 * CostHandler orchestration (GetRun + tasks + rate card + RUN_FILESYSTEM query)
 * stays I/O-only. Every function here is pure and total: it never performs I/O,
 * never throws on malformed-but-typed input, and — honoring the repo's strict
 * no-fabrication rule (Req 6) — returns `null` (an explicit
 * Estimate_Unavailable_State) rather than a guessed or zero-filled number when a
 * value cannot be computed.
 *
 * Value semantics mirror design.md §5 "Cost math":
 *   - Compute: per task, `instanceHours = (stop - start)` in hours; summed by
 *     `instanceType`; × the instance type's published rate.
 *   - Storage STATIC: `storageCapacity` (GiB) × run wall-clock hours × the
 *     "Run Storage" rate.
 *   - Storage DYNAMIC: `trapezoidalGbHours` of the RUN_FILESYSTEM usage series
 *     × the "Dynamic Run Storage" rate; series absent => unavailable.
 */

/** Category of a cost line item (mirrors the GraphQL `CostCategory` enum). */
export type CostCategory = 'COMPUTE' | 'STORAGE';

/**
 * One row of the estimate breakdown (mirrors the GraphQL `CostLineItem` type).
 *
 * `quantity`, `ratePerUnit`, and `estimatedCost` are `null` whenever the line
 * item is in the Estimate_Unavailable_State (`available === false`); they are
 * never zero-filled to stand in for an uncomputable value (Req 6.1).
 */
export interface CostLineItem {
  category: CostCategory;
  /** Human usage type, e.g. "Compute (omics.r.2xlarge)" or "Dynamic Run Storage". */
  usageType: string;
  /** Instance type (compute) or storage-family label (storage); `null` when not applicable. */
  resourceType: string | null;
  /** Quantity in `unit` (Instance-hrs or GB-Hours); `null` when unavailable. */
  quantity: number | null;
  /** `"Instance-hrs"` | `"GB-Hours"`. */
  unit: string;
  /** Published On-Demand rate per unit; `null` when unavailable. */
  ratePerUnit: number | null;
  /** `quantity * ratePerUnit`; `null` when unavailable. */
  estimatedCost: number | null;
  /** `false` => this line item is in the Estimate_Unavailable_State (Req 6.2). */
  available: boolean;
  /** Why unavailable (e.g. "No rate for omics.x"); `null` when available. */
  unavailableReason: string | null;
}

/** A published per-unit rate keyed in the rate map by `resourceType`. */
export interface Rate {
  pricePerUnit: number;
  unit: string;
}

/**
 * The rate map keyed by `resourceType` (instance types + the two storage family
 * labels), as built from the Price List API and cached in the rate card.
 */
export type RateMap = Record<string, Rate>;

/** The minimal task shape the compute aggregation needs. */
export interface TaskLike {
  /** The task's compute instance type (e.g. `omics.m.large`); absent when uncaptured. */
  instanceType?: string | null;
  /** ISO 8601 start timestamp; absent when the task has not started. */
  startedAt?: string | null;
  /** ISO 8601 stop timestamp; absent when the task has not stopped. */
  stoppedAt?: string | null;
}

/** A single sampled usage point: epoch milliseconds + value in bytes. */
export interface UsagePoint {
  timestamp: number;
  value: number;
}

/** The two Price List storage-family labels, selected by the run's `storageType`. */
export const STORAGE_FAMILY_STATIC = 'Run Storage';
export const STORAGE_FAMILY_DYNAMIC = 'Dynamic Run Storage';

const HOUR_MS = 60 * 60 * 1000;
const COMPUTE_UNIT = 'Instance-hrs';
const STORAGE_UNIT = 'GB-Hours';

/**
 * Wall-clock hours from ISO `startedAt`/`stoppedAt` (Req 2.1).
 *
 * Returns `null` — never a fabricated 0 — when either timestamp is
 * missing/unparseable or when `stop < start` (an inverted interval). Otherwise
 * the difference `(stop - start)` expressed in hours.
 */
export function instanceHours(
  startedAt?: string | null,
  stoppedAt?: string | null,
): number | null {
  if (startedAt == null || stoppedAt == null) {
    return null;
  }
  const start = Date.parse(startedAt);
  const stop = Date.parse(stoppedAt);
  if (Number.isNaN(start) || Number.isNaN(stop)) {
    return null;
  }
  if (stop < start) {
    return null;
  }
  return (stop - start) / HOUR_MS;
}

/**
 * Result of aggregating per-task compute hours by instance type.
 */
export interface ComputeAggregate {
  /** `instanceType` -> summed Instance_Hours (only tasks with usable runtime). */
  byInstanceType: Map<string, number>;
  /** Count of tasks that have runtime but no `instanceType` (Req 2.4). */
  missingInstanceTypeCount: number;
  /** Count of tasks excluded because they have no usable start→stop runtime (Req 2.5). */
  excludedNoRuntimeCount: number;
}

/**
 * Group tasks by `instanceType`, summing Instance_Hours (Req 2.2, 2.4, 2.5).
 *
 * A task with no usable start→stop runtime is excluded from every total and
 * counted in `excludedNoRuntimeCount` rather than assigned a fabricated runtime
 * (Req 2.5). A task that has runtime but no `instanceType` is counted in
 * `missingInstanceTypeCount` rather than priced against a fabricated instance
 * type (Req 2.4). Only tasks with both a usable runtime and an `instanceType`
 * contribute to `byInstanceType`.
 */
export function aggregateComputeHours(
  tasks: readonly TaskLike[],
): ComputeAggregate {
  const byInstanceType = new Map<string, number>();
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
    byInstanceType.set(type, (byInstanceType.get(type) ?? 0) + hours);
  }

  return { byInstanceType, missingInstanceTypeCount, excludedNoRuntimeCount };
}

/**
 * Convert bytes to decimal GB (1e9 bytes per GB), pure and total for any finite
 * input. Matches the Price List "GB-Hours" unit, which is decimal GB.
 */
export function bytesToGb(bytes: number): number {
  return bytes / 1e9;
}

/**
 * Trapezoidal time-integral of a sampled usage series to GB-hours (Req 3.3).
 *
 * Points are `{ timestamp: epoch ms, value: bytes }`. Each value is converted to
 * GB via {@link bytesToGb} and the integral is Σ over consecutive pairs of
 * `(average GB of the pair) × (Δt in hours)`. Points are sorted by timestamp
 * first so an out-of-order series still integrates over its true timespan.
 *
 * Returns `0` for a single point (a zero-width interval — real, not fabricated)
 * and `null` for an empty series, so the caller shows the storage
 * Estimate_Unavailable_State rather than a fabricated 0 (Req 3.4).
 */
export function trapezoidalGbHours(
  points: readonly UsagePoint[],
): number | null {
  if (points.length === 0) {
    return null;
  }
  if (points.length === 1) {
    return 0;
  }

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

/**
 * Assemble compute line items from aggregated hours + the rate map (Req 2.2,
 * 2.3, 2.4, 2.6).
 *
 * Emits one `CostLineItem` per instance type in `agg.byInstanceType`:
 *   - present in `rateMap` => `available: true`, `quantity` = summed hours,
 *     `ratePerUnit` = the rate, `estimatedCost` = their product (Req 2.3).
 *   - absent from `rateMap` => `available: false` with the summed hours still
 *     shown as `quantity` but no rate/cost fabricated (Req 2.6).
 *
 * When any task lacked an `instanceType`, a single trailing `available: false`
 * "unpriced compute" line item carries the `missingInstanceTypeCount` in its
 * `unavailableReason` (Req 2.4). Tasks excluded for lacking runtime are surfaced
 * via `excludedNoRuntimeCount` on the produced line items' reasons rather than
 * fabricated (Req 2.5). Instance types are emitted in a stable sorted order for
 * deterministic output.
 */
export function computeComputeLineItems(
  agg: ComputeAggregate,
  rateMap: RateMap,
): CostLineItem[] {
  const items: CostLineItem[] = [];
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

/** Arguments to {@link computeStorageLineItem}. */
export interface StorageLineItemArgs {
  /** The run's storage mode: `"STATIC"` or `"DYNAMIC"` (HealthOmics `storageType`). */
  storageType?: string | null;
  /** Static storage capacity in GiB (HealthOmics `storageCapacity`); used for STATIC. */
  storageCapacityGb?: number | null;
  /** The run's wall-clock hours (start→stop-or-now); used for STATIC. */
  runHours?: number | null;
  /**
   * The DYNAMIC RUN_FILESYSTEM usage series (epoch ms + bytes), or `null`/absent
   * when the measured series is unavailable (Req 3.4).
   */
  filesystemPoints?: readonly UsagePoint[] | null;
  /** The rate map keyed by `resourceType`; storage rates keyed by family label. */
  rateMap: RateMap;
}

/**
 * Assemble the single storage `CostLineItem` from the run's storage type +
 * inputs + the rate map (Req 3.1, 3.2, 3.3, 3.5, 3.6).
 *
 * The Storage_Family is selected from `storageType` (`STATIC` -> "Run Storage",
 * `DYNAMIC` -> "Dynamic Run Storage"; Req 3.1). The quantity is:
 *   - STATIC: `storageCapacityGb × runHours` (Req 3.2).
 *   - DYNAMIC: `trapezoidalGbHours(filesystemPoints)` (Req 3.3); an absent or
 *     empty series yields `available: false` (Req 3.4).
 * `estimatedCost` = `quantity × familyRate`. A missing family rate yields
 * `available: false` (Req 3.6). No value is fabricated or zero-filled: when a
 * required input is missing the line item is unavailable with a reason.
 */
export function computeStorageLineItem(args: StorageLineItemArgs): CostLineItem {
  const { storageType, storageCapacityGb, runHours, filesystemPoints, rateMap } =
    args;

  const normalized = typeof storageType === 'string' ? storageType.toUpperCase() : null;
  const family =
    normalized === 'DYNAMIC'
      ? STORAGE_FAMILY_DYNAMIC
      : normalized === 'STATIC'
        ? STORAGE_FAMILY_STATIC
        : null;

  // Unknown/absent storage type => cannot select a family (Req 3.1).
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

  // Quantity (GB-hours) depends on the storage family.
  let quantity: number | null;
  let quantityReason: string | null = null;
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
    // DYNAMIC: integrate the measured RUN_FILESYSTEM series (Req 3.3, 3.4).
    quantity =
      filesystemPoints == null ? null : trapezoidalGbHours(filesystemPoints);
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
