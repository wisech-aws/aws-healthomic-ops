import { describe, it, expect, vi } from 'vitest';

import {
  loadRateCard,
  isStale,
  RATE_CARD_STALENESS_MS,
  type RateCardRepository,
  type RateCardPriceList,
} from '../src/cost/rateCard.js';
import type { RateCardItem } from '../src/repository.js';
import type { RateMapResult } from '../src/cost/priceList.js';

// `loadRateCard` takes its collaborators as parameters, so these are pure unit tests: a
// hand-built fake repo + fake price-list implementing the structural interfaces, with the
// mutating methods as `vi.fn()` spies so we can assert exactly what was (and wasn't) called.
// No AWS mocking is needed.

const REGION = 'us-east-1';

/** A non-empty rate map, as a healthy `fetchRateMap` returns. */
const NON_EMPTY_RATES: RateMapResult['rates'] = {
  'omics.m.large': { pricePerUnit: 0.12, unit: 'Instance-hrs' },
  'Dynamic Run Storage': { pricePerUnit: 0.0001, unit: 'GB-Hours' },
};

/** Build a cached rate-card item stamped `updatedAt` for staleness control. */
function cachedItem(updatedAt: string): RateCardItem {
  return {
    PK: `REGION#${REGION}`,
    SK: 'RATECARD',
    region: REGION,
    rates: {
      'omics.c.large': { pricePerUnit: 0.09, unit: 'Instance-hrs' },
    },
    currency: 'USD',
    effectiveDate: '2024-01-01',
    updatedAt,
    entityType: 'RATECARD',
  };
}

/** A repo fake with spy methods; `getRateCard` resolves to the provided cache value. */
function makeRepo(cached: RateCardItem | null): RateCardRepository & {
  putRateCard: ReturnType<typeof vi.fn>;
  recordRateCardFailure: ReturnType<typeof vi.fn>;
} {
  return {
    getRateCard: vi.fn(async () => cached),
    putRateCard: vi.fn(async () => undefined),
    recordRateCardFailure: vi.fn(async () => undefined),
  };
}

/** A price-list fake whose `fetchRateMap` resolves to `result`. */
function makeFetchingPriceList(result: RateMapResult): RateCardPriceList & {
  fetchRateMap: ReturnType<typeof vi.fn>;
} {
  return { fetchRateMap: vi.fn(async () => result) };
}

/** A price-list fake whose `fetchRateMap` rejects with `error`. */
function makeThrowingPriceList(error: Error): RateCardPriceList & {
  fetchRateMap: ReturnType<typeof vi.fn>;
} {
  return {
    fetchRateMap: vi.fn(async () => {
      throw error;
    }),
  };
}

describe('loadRateCard', () => {
  const now = '2024-06-01T00:00:00.000Z';

  it('serves a fresh non-stale cache hit without calling the API or writing the cache', async () => {
    // updatedAt just now → well within the staleness window.
    const repo = makeRepo(cachedItem(now));
    const priceList = makeFetchingPriceList({ rates: NON_EMPTY_RATES, currency: 'USD' });

    const result = await loadRateCard(repo, priceList, REGION, now);

    expect(result.status).toBe('ok');
    expect(result).toMatchObject({ stale: false });
    expect(priceList.fetchRateMap).not.toHaveBeenCalled();
    expect(repo.putRateCard).not.toHaveBeenCalled();
  });

  it('caches and returns a fresh card on a non-empty fetch with no cache', async () => {
    const repo = makeRepo(null);
    const priceList = makeFetchingPriceList({ rates: NON_EMPTY_RATES, currency: 'USD' });

    const result = await loadRateCard(repo, priceList, REGION, now);

    expect(result).toEqual({
      status: 'ok',
      rates: NON_EMPTY_RATES,
      currency: 'USD',
      effectiveDate: '2024-06-01',
      stale: false,
    });
    expect(repo.putRateCard).toHaveBeenCalledTimes(1);
    expect(repo.putRateCard).toHaveBeenCalledWith(REGION, NON_EMPTY_RATES, 'USD', '2024-06-01');
    expect(repo.recordRateCardFailure).not.toHaveBeenCalled();
  });

  it('treats an EMPTY fetch with no cache as unavailable (never caches an empty map)', async () => {
    const repo = makeRepo(null);
    const priceList = makeFetchingPriceList({ rates: {}, currency: 'USD' });

    const result = await loadRateCard(repo, priceList, REGION, now);

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('no usable rates');
      expect(result.reason).toContain(REGION);
    }
    expect(repo.putRateCard).not.toHaveBeenCalled();
  });

  it('serves the stale cached card (never the empty map) on an EMPTY fetch, recording failure', async () => {
    // updatedAt older than the staleness window → cache present but stale.
    const staleAt = new Date(Date.parse(now) - RATE_CARD_STALENESS_MS - 1000).toISOString();
    const cached = cachedItem(staleAt);
    const repo = makeRepo(cached);
    const priceList = makeFetchingPriceList({ rates: {}, currency: 'USD' });

    const result = await loadRateCard(repo, priceList, REGION, now);

    expect(result).toEqual({
      status: 'ok',
      rates: cached.rates,
      currency: cached.currency,
      effectiveDate: cached.effectiveDate,
      stale: true,
    });
    expect(repo.putRateCard).not.toHaveBeenCalled();
    expect(repo.recordRateCardFailure).toHaveBeenCalledTimes(1);
    expect(repo.recordRateCardFailure).toHaveBeenCalledWith(
      REGION,
      expect.stringContaining('no usable rates'),
    );
  });

  it('serves the stale cached card when the fetch throws, recording failure', async () => {
    const staleAt = new Date(Date.parse(now) - RATE_CARD_STALENESS_MS - 1000).toISOString();
    const cached = cachedItem(staleAt);
    const repo = makeRepo(cached);
    const priceList = makeThrowingPriceList(new Error('Price List timeout'));

    const result = await loadRateCard(repo, priceList, REGION, now);

    expect(result).toEqual({
      status: 'ok',
      rates: cached.rates,
      currency: cached.currency,
      effectiveDate: cached.effectiveDate,
      stale: true,
    });
    expect(repo.putRateCard).not.toHaveBeenCalled();
    expect(repo.recordRateCardFailure).toHaveBeenCalledWith(REGION, 'Price List timeout');
  });

  it('returns unavailable when the fetch throws and there is no cache', async () => {
    const repo = makeRepo(null);
    const priceList = makeThrowingPriceList(new Error('Price List timeout'));

    const result = await loadRateCard(repo, priceList, REGION, now);

    expect(result).toEqual({ status: 'unavailable', reason: 'Price List timeout' });
    expect(repo.putRateCard).not.toHaveBeenCalled();
    expect(repo.recordRateCardFailure).not.toHaveBeenCalled();
  });
});

describe('isStale', () => {
  const now = Date.parse('2024-06-01T00:00:00.000Z');

  it('is false for a card updated within the threshold', () => {
    const updatedAt = new Date(now - RATE_CARD_STALENESS_MS + 1000).toISOString();
    expect(isStale(updatedAt, now, RATE_CARD_STALENESS_MS)).toBe(false);
  });

  it('is true for a card older than the threshold', () => {
    const updatedAt = new Date(now - RATE_CARD_STALENESS_MS - 1000).toISOString();
    expect(isStale(updatedAt, now, RATE_CARD_STALENESS_MS)).toBe(true);
  });

  it('treats an unparseable updatedAt as stale', () => {
    expect(isStale('not-a-date', now, RATE_CARD_STALENESS_MS)).toBe(true);
  });
});
