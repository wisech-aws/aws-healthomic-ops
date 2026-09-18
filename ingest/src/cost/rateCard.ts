/**
 * Rate-card service: cache-first, lazily-refreshed, stale-on-failure retrieval of a
 * region's published On-Demand rate card (Req 4.1–4.5, design §4 "Rate-card service").
 *
 * The load-bearing theme is honesty about availability: `loadRateCard` returns a real,
 * usable rate card (fresh, refreshed, or served-stale) or a typed `"unavailable"` sentinel
 * — it never fabricates rates. The orchestration is I/O over two injectable dependencies (a
 * repo-like cache and a Price List-like fetcher) so it can be unit-tested without AWS,
 * mirroring how the other cost modules take their collaborators as parameters.
 *
 * Control flow (design §4):
 *   1. `getRateCard(region)` present and NOT stale → reuse without calling the API (4.1).
 *   2. Absent, or present-but-stale → `fetchRateMap`; on a NON-EMPTY result `putRateCard` with
 *      `effectiveDate = today` and return the freshly-built card (4.2, 4.3; lazy refresh —
 *      never polling). An EMPTY fetched rate map is treated as a soft failure (steps 3/4), not
 *      a cacheable success, so it is never written to the cache.
 *   3. API failure WITH a cached card present → `recordRateCardFailure` and return the
 *      stale cached card rather than failing the estimate (4.4).
 *   4. API failure WITH no cached card → return the typed `"unavailable"` sentinel so the
 *      handler emits the Estimate_Unavailable_State rather than fabricating rates (4.5).
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.5.
 */
import type { RateCardItem } from '../repository.js';
import type { RateMapResult } from './priceList.js';

/**
 * The age (in milliseconds) beyond which a cached rate card is considered stale and eligible
 * for lazy refresh on the next request (~7 days, design §4 Staleness_Threshold). A card is
 * refreshed exactly when it is older than this and never before (Req 4.3).
 */
export const RATE_CARD_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A resolved rate card ready for pricing: the region's rate map plus the metadata the
 * handler surfaces (`currency`, `effectiveDate`). `stale` is `true` when the card was served
 * from cache after a Price List API failure (Req 4.4), so the caller can note the rates may
 * be out of date; `false` for a fresh cache hit or a successful refresh.
 */
export interface ResolvedRateCard {
  readonly status: 'ok';
  readonly rates: Record<string, { pricePerUnit: number; unit: string }>;
  readonly currency: string;
  readonly effectiveDate: string;
  /** `true` when this card was served stale after a Price List API failure (Req 4.4). */
  readonly stale: boolean;
}

/**
 * The typed "unavailable" sentinel returned when no rate card can be produced — neither a
 * cached card nor a successful Price List fetch (Req 4.5). The handler maps this to the
 * Estimate_Unavailable_State instead of fabricating rates.
 */
export interface UnavailableRateCard {
  readonly status: 'unavailable';
  /** Why the card is unavailable (the underlying fetch error message), for logging/diagnostics. */
  readonly reason: string;
}

/**
 * The discriminated result the CostHandler consumes: either a usable {@link ResolvedRateCard}
 * (`status: 'ok'`) or the {@link UnavailableRateCard} sentinel (`status: 'unavailable'`).
 */
export type RateCardResult = ResolvedRateCard | UnavailableRateCard;

/**
 * The repository surface `loadRateCard` depends on — the subset of `DynamoRepository` used
 * for the rate-card cache. Declared structurally so tests can inject a lightweight fake.
 */
export interface RateCardRepository {
  getRateCard(region: string): Promise<RateCardItem | null>;
  putRateCard(
    region: string,
    rates: Record<string, { pricePerUnit: number; unit: string }>,
    currency: string,
    effectiveDate: string,
  ): Promise<void>;
  recordRateCardFailure(region: string, reason: string): Promise<void>;
}

/**
 * The Price List surface `loadRateCard` depends on — just the region rate-map fetcher.
 * Declared structurally so tests can inject a fake in place of {@link fetchRateMap}.
 */
export interface RateCardPriceList {
  fetchRateMap(region: string): Promise<RateMapResult>;
}

/**
 * Pure staleness predicate: a card stamped `updatedAt` is stale relative to `now` when it is
 * strictly older than `thresholdMs` — i.e. `now - updatedAt > thresholdMs` (Req 4.3).
 *
 * An unparseable `updatedAt` is treated as stale (`true`) so a malformed cache entry is
 * refreshed rather than trusted indefinitely. This function performs no I/O and depends only
 * on its arguments.
 *
 * @param updatedAt ISO-8601 timestamp the card was last written.
 * @param now       The reference instant (ISO-8601 string or epoch milliseconds).
 * @param thresholdMs The staleness threshold in milliseconds.
 */
export function isStale(updatedAt: string, now: string | number, thresholdMs: number): boolean {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return true;
  }
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return true;
  }
  return nowMs - updatedMs > thresholdMs;
}

/** Format an instant as an ISO date (`YYYY-MM-DD`) for the rate card's `effectiveDate`. */
function toEffectiveDate(now: string | number): string {
  const date = new Date(now);
  const iso = date.toISOString();
  return iso.slice(0, 'YYYY-MM-DD'.length);
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a resolved card from a fetched rate map, stamped with today's `effectiveDate`.
 */
function resolvedFromFetch(fetched: RateMapResult, effectiveDate: string): ResolvedRateCard {
  return {
    status: 'ok',
    rates: fetched.rates,
    currency: fetched.currency,
    effectiveDate,
    stale: false,
  };
}

/** Build a served-stale resolved card from a cached item (Req 4.4). */
function resolvedFromCache(cached: RateCardItem, stale: boolean): ResolvedRateCard {
  return {
    status: 'ok',
    rates: cached.rates,
    currency: cached.currency,
    effectiveDate: cached.effectiveDate,
    stale,
  };
}

/**
 * Shared fallback for a fetch that did not yield a usable rate card — either the Price List
 * call threw, OR it "succeeded" but returned an EMPTY rate map (see `loadRateCard`). Both are
 * treated identically (Req 4.4, 4.5): with a cached card present, record the failure and serve
 * that card stale; with no cache, return the typed `"unavailable"` sentinel. This keeps the
 * caught-exception path and the empty-map path going through one branch so they can never
 * drift apart.
 */
async function fallbackAfterFetchFailure(
  repo: RateCardRepository,
  region: string,
  cached: RateCardItem | null,
  reason: string,
): Promise<RateCardResult> {
  // (3) Failure with a cached card → mark the failure and serve the stale card (Req 4.4).
  if (cached !== null) {
    await repo.recordRateCardFailure(region, reason);
    return resolvedFromCache(cached, true);
  }
  // (4) Failure with no cache → typed unavailable sentinel (Req 4.5).
  return { status: 'unavailable', reason };
}

/**
 * Load the rate card for a region: cache-first, lazy-refresh when stale, serve-stale on API
 * failure, typed-unavailable when neither a cache nor the API yields rates (Req 4.1–4.5).
 *
 * @param repo      Rate-card cache (a `DynamoRepository` or structural fake).
 * @param priceList Price List fetcher (the `priceList` module or a structural fake).
 * @param region    The region whose rate card to load.
 * @param now       Reference instant for staleness and `effectiveDate` (defaults to `Date.now()`).
 */
export async function loadRateCard(
  repo: RateCardRepository,
  priceList: RateCardPriceList,
  region: string,
  now: string | number = Date.now(),
): Promise<RateCardResult> {
  const cached = await repo.getRateCard(region);

  // (1) Fresh cache hit → reuse without calling the Price List API (Req 4.1).
  if (cached !== null && !isStale(cached.updatedAt, now, RATE_CARD_STALENESS_MS)) {
    return resolvedFromCache(cached, false);
  }

  // (2)–(4) Absent or stale → attempt a lazy refresh from the Price List API (Req 4.2, 4.3).
  try {
    const fetched = await priceList.fetchRateMap(region);

    // An EMPTY rate map is treated as a FAILURE, not a cacheable success. A Price List call
    // that resolves without error yet yields zero rates is almost certainly an upstream or
    // response-shape problem (the incident this guards against: a parser bug dropped every
    // product, `fetchRateMap` returned {} rates, and `putRateCard` cached that empty map as a
    // fresh, non-stale, failureReason-free card — poisoning the cache for the whole ~7-day
    // staleness window so every later request served the empty card and never re-fetched).
    // So we never `putRateCard` an empty map; we fall through to the same fallback as a thrown
    // fetch (serve any cached card stale, else report unavailable) — which keeps the card
    // eligible for a real refresh on the next request instead of durably caching nothing.
    if (Object.keys(fetched.rates).length === 0) {
      return fallbackAfterFetchFailure(
        repo,
        region,
        cached,
        `Price List returned no usable rates for region "${region}"`,
      );
    }

    const effectiveDate = toEffectiveDate(now);
    await repo.putRateCard(region, fetched.rates, fetched.currency, effectiveDate);
    return resolvedFromFetch(fetched, effectiveDate);
  } catch (error) {
    // (3)/(4) API failure → serve stale cached card if present, else typed unavailable.
    return fallbackAfterFetchFailure(repo, region, cached, errorMessage(error));
  }
}
