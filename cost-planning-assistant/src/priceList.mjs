/**
 * priceList.mjs — the Price_List client. THE ONLY AWS I/O IN THIS PACKAGE.
 *
 * Mirrors the confirmed Price List parsing shape documented in
 * `ingest/src/cost/priceList.ts` (re-expressed locally per this package's
 * standalone, dependency-isolated posture — see design.md's note on
 * intentional, precedented duplication):
 *
 *   - Paginate `GetProductsCommand` for `ServiceCode=AmazonOmics`, filtered by
 *     `regionCode` + `workflowType=Private`.
 *   - Each `PriceList` entry is a JSON payload; the pinned `@aws-sdk/client-pricing`
 *     version hands these back as boxed `String` OBJECTS (`typeof entry === "object"`),
 *     so coerce with `String(raw)` before `JSON.parse` rather than gating on
 *     `typeof === 'string'`.
 *   - Keep ONLY `product.productFamily === "Compute"` entries whose
 *     `attributes.resourceType` is either an omics instance type (unit
 *     `Instance-hrs`) or exactly `"Run Storage"`/`"Dynamic Run Storage"` (unit
 *     `GB-Hours`). Everything else (Ephemeral Storage, sequence/annotation/
 *     variant-store, Ready2Run) is skipped.
 *   - The On-Demand rate lives at
 *     `terms.OnDemand.<firstTermKey>.priceDimensions.<firstDimKey>.pricePerUnit.USD`.
 *
 * NEVER fabricates a rate: any product that is out of scope, or missing any
 * needed field, is skipped (returns `null` from the parser) rather than
 * zero-filled or guessed.
 *
 * The `PricingClient` is INJECTED — this module never constructs one, so
 * tests (and `plan-cost.mjs --help`) never touch AWS or need credentials.
 */
import { GetProductsCommand } from '@aws-sdk/client-pricing';

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

/** Read a nested property without assuming any level exists. */
function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : null;
}

/**
 * The first value of an object whose keys are opaque ids (the
 * `terms.OnDemand.<termKey>` and `priceDimensions.<dimKey>` maps both key by
 * SKU-derived ids, so we take the first entry). Returns `null` for a
 * non-object or empty map.
 */
function firstValue(value) {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const keys = Object.keys(record);
  return keys.length > 0 ? record[keys[0]] : null;
}

/**
 * Pure parse of one `PriceList` JSON string into a single keyed rate, or
 * `null` to skip. Exported so tests can exercise it directly with fixture
 * payloads.
 *
 * @param {string} raw
 * @returns {{resourceType:string, pricePerUnit:number, unit:string}|null}
 */
export function parsePriceListItem(raw) {
  let parsed;
  try {
    // Coerce to a primitive string first: this SDK version can hand back
    // boxed `String` objects rather than primitives. `JSON.parse` coerces
    // already, but `String(raw)` makes that self-documenting and safe for
    // either shape.
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

  // Gate on family + matching unit: an instance type in Instance-hrs, or a
  // storage label in GB-Hours. Anything else (e.g. Ephemeral Storage, or a
  // mismatched unit) is out of scope.
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

/**
 * Fetch a region's `AmazonOmics` Private-workflow rate map from the Price
 * List API.
 *
 * Paginates `GetProductsCommand` following `NextToken`, mapping each
 * `PriceList` entry through {@link parsePriceListItem} and reducing the
 * surviving rates into a single map keyed by `resourceType`. A malformed
 * item parses to `null` and is skipped — never zero-filled — so the returned
 * map contains only real, published rates.
 *
 * @param {{region:string, pricingClient:{send: Function}}} args
 *   `pricingClient` is REQUIRED and injected — this function never
 *   constructs a `PricingClient` itself.
 * @returns {Promise<{rates: Record<string, {pricePerUnit:number, unit:string}>, currency:string, retrievedAt:string}>}
 */
export async function fetchRateMap({ region, pricingClient }) {
  const rates = {};
  let nextToken;

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
      // This SDK version returns each PriceList entry as a boxed `String`
      // OBJECT, not a primitive string — so `typeof raw` is `"object"`, and
      // gating on `typeof === 'string'` would drop EVERY entry (leaving an
      // empty rate map). Coerce with `String(raw)`, which normalizes both
      // boxed-String objects and primitive strings, then parse. Skip only
      // genuinely absent entries.
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

  return { rates, currency: 'USD', retrievedAt: new Date().toISOString() };
}
