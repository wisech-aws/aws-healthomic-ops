/**
 * AWS Price List client for HealthOmics compute + run-storage On-Demand rates.
 *
 * This module isolates every assumption about the shape of a `pricing:GetProducts`
 * response for ServiceCode `AmazonOmics`, so that if the Price List attribute shape ever
 * differs, only this one file changes (mirroring how `metricsHandler.ts`/`logsHandler.ts`
 * isolate their own AWS-shape assumptions). It exposes two things:
 *
 *   - {@link parsePriceListItem} — a pure parser of a single `PriceList` JSON string into
 *     one keyed rate, or `null` to skip. It NEVER fabricates a rate: any product that is
 *     out of scope, or is missing any needed field, yields `null`.
 *   - {@link fetchRateMap} — paginates `GetProductsCommand` for a region's Private-workflow
 *     `AmazonOmics` products and reduces the parsed items into a single rate map keyed by
 *     `attributes.resourceType`.
 *
 * ### Confirmed AWS-shape (verified live against us-east-1 during investigation)
 *
 * Each `PriceList` entry returned by `pricing:GetProducts` is a JSON payload that must be
 * `JSON.parse`d. NOTE: the pinned `@aws-sdk/client-pricing` version hands these back as boxed
 * `String` OBJECTS (so `typeof entry === "object"`, not `"string"`); coerce with `String(...)`
 * before parsing rather than gating on `typeof === 'string'`. BOTH compute and run-storage
 * products carry
 * `product.productFamily === "Compute"` and a `product.attributes.resourceType`:
 *
 *   - COMPUTE: `resourceType` is the omics instance type (e.g. `omics.m.large`), unit
 *     `Instance-hrs`.
 *   - STORAGE: `resourceType` is exactly `"Dynamic Run Storage"` or `"Run Storage"`, unit
 *     `GB-Hours`.
 *
 * The On-Demand rate lives at
 * `terms.OnDemand.<firstTermKey>.priceDimensions.<firstDimKey>` =
 * `{ unit, pricePerUnit: { USD } }`.
 *
 * Out-of-scope products that exist but are deliberately skipped: `"Ephemeral Storage"`,
 * sequence/annotation/variant-store, and Ready2Run per-run products. They are excluded by
 * the `productFamily`/`resourceType`/`unit` gate below.
 *
 * @see Requirements 4.2 (Design §4 "Price List client (`priceList.ts`)").
 */
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';

/** The Price List ServiceCode for HealthOmics products. */
const SERVICE_CODE = 'AmazonOmics';

/** The only `productFamily` in scope; both compute and run-storage products use it. */
const COMPUTE_PRODUCT_FAMILY = 'Compute';

/** The storage-family `resourceType` labels (unit `GB-Hours`) that are in scope. */
const STORAGE_RESOURCE_TYPES = new Set(['Dynamic Run Storage', 'Run Storage']);

/** The unit an in-scope compute product's rate is published in. */
const COMPUTE_UNIT = 'Instance-hrs';

/** The unit an in-scope storage product's rate is published in. */
const STORAGE_UNIT = 'GB-Hours';

/** One published On-Demand rate, keyed by the product's `attributes.resourceType`. */
export interface ParsedRate {
  /** `attributes.resourceType`: an omics instance type or a storage-family label. */
  resourceType: string;
  /** The On-Demand `pricePerUnit.USD`, parsed to a finite number. */
  pricePerUnit: number;
  /** The published unit: `"Instance-hrs"` (compute) or `"GB-Hours"` (storage). */
  unit: string;
}

/** A region's rate map plus its currency, as reduced from the parsed Price List items. */
export interface RateMapResult {
  /** `resourceType` -> its published rate. */
  rates: Record<string, { pricePerUnit: number; unit: string }>;
  /** Always `"USD"` for the verified regions. */
  currency: string;
}

/** Read a nested property without assuming any level exists. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The first value of an object whose keys are opaque ids (the `terms.OnDemand.<termKey>` and
 * `priceDimensions.<dimKey>` maps both key by SKU-derived ids, so we take the first entry).
 * Returns `null` for a non-object or empty map.
 */
function firstValue(value: unknown): unknown {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const keys = Object.keys(record);
  return keys.length > 0 ? record[keys[0]] : null;
}

/**
 * Pure parse of one `PriceList` JSON string into a single keyed rate, or `null` to skip.
 *
 * Keeps ONLY a product whose `product.productFamily === "Compute"` and whose
 * `product.attributes.resourceType` is either an omics instance type published in
 * `Instance-hrs`, or exactly one of the two storage-family labels published in `GB-Hours`.
 * Everything else (`"Ephemeral Storage"`, sequence/annotation/variant-store, Ready2Run,
 * or a product whose published unit does not match its family) yields `null`.
 *
 * The rate is read from `terms.OnDemand.<firstTermKey>.priceDimensions.<firstDimKey>` =
 * `{ unit, pricePerUnit: { USD } }`. Returns `null` whenever any needed field is absent,
 * malformed, or non-finite — this parser NEVER fabricates a rate. Total over any input
 * (including non-JSON strings): a parse error is caught and reported as `null`.
 */
export function parsePriceListItem(raw: string): ParsedRate | null {
  let parsed: unknown;
  try {
    // Coerce to a primitive string first: this SDK version can hand back boxed
    // `String` objects rather than primitives. `JSON.parse` coerces already, but
    // `String(raw)` makes that self-documenting and safe for either shape.
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  const product = asRecord(root?.product);
  const attributes = asRecord(product?.attributes);
  if (product === null || attributes === null) {
    return null;
  }

  if (product.productFamily !== COMPUTE_PRODUCT_FAMILY) {
    return null;
  }

  const resourceType = attributes.resourceType;
  if (typeof resourceType !== 'string' || resourceType.trim() === '') {
    return null;
  }

  // Read the On-Demand rate: terms.OnDemand.<termKey>.priceDimensions.<dimKey>.
  const terms = asRecord(root?.terms);
  const onDemand = firstValue(terms?.OnDemand);
  const priceDimension = firstValue(asRecord(onDemand)?.priceDimensions);
  const dimension = asRecord(priceDimension);
  if (dimension === null) {
    return null;
  }

  const unit = dimension.unit;
  if (typeof unit !== 'string') {
    return null;
  }

  // Gate on family + matching unit: an instance-type in Instance-hrs, or a storage label in
  // GB-Hours. Anything else (e.g. Ephemeral Storage, or a mismatched unit) is out of scope.
  const isStorage = STORAGE_RESOURCE_TYPES.has(resourceType);
  const isInScope = isStorage ? unit === STORAGE_UNIT : unit === COMPUTE_UNIT;
  if (!isInScope) {
    return null;
  }

  const pricePerUnitRaw = asRecord(dimension.pricePerUnit)?.USD;
  if (typeof pricePerUnitRaw !== 'string' && typeof pricePerUnitRaw !== 'number') {
    return null;
  }
  const pricePerUnit = Number(pricePerUnitRaw);
  if (!Number.isFinite(pricePerUnit)) {
    return null;
  }

  return { resourceType, pricePerUnit, unit };
}

const pricingClient = new PricingClient({});

/**
 * Fetch a region's `AmazonOmics` Private-workflow rate map from the Price List API.
 *
 * Paginates `GetProductsCommand({ ServiceCode: 'AmazonOmics', Filters: [regionCode=<region>,
 * workflowType='Private'] })` following `NextToken`, mapping each `PriceList` JSON string
 * through {@link parsePriceListItem} and reducing the surviving rates into a single map
 * keyed by `resourceType`. A malformed item parses to `null` and is skipped — never
 * zero-filled — so the returned map contains only real, published rates.
 */
export async function fetchRateMap(region: string): Promise<RateMapResult> {
  const rates: Record<string, { pricePerUnit: number; unit: string }> = {};
  let nextToken: string | undefined;

  do {
    const response = await pricingClient.send(
      new GetProductsCommand({
        ServiceCode: SERVICE_CODE,
        Filters: [
          { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
          { Type: 'TERM_MATCH', Field: 'workflowType', Value: 'Private' },
        ],
        NextToken: nextToken,
      }),
    );

    for (const raw of response.PriceList ?? []) {
      // This SDK version returns each PriceList entry as a boxed `String` OBJECT,
      // not a primitive string — so `typeof raw` is `"object"`, and gating on
      // `typeof === 'string'` would drop EVERY entry (leaving an empty rate map).
      // Coerce with `String(raw)`, which normalizes both boxed-String objects and
      // primitive strings, then parse. Skip only genuinely absent entries.
      if (raw == null) {
        continue;
      }
      const text = String(raw);
      const parsed = parsePriceListItem(text);
      if (parsed !== null) {
        rates[parsed.resourceType] = { pricePerUnit: parsed.pricePerUnit, unit: parsed.unit };
      }
    }

    nextToken = response.NextToken ?? undefined;
  } while (nextToken !== undefined);

  return { rates, currency: 'USD' };
}
