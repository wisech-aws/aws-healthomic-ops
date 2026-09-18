import { describe, it, expect, vi, beforeEach } from 'vitest';

// `priceList.ts` constructs a `PricingClient` at module load, so the SDK must be
// mocked before the static import below. `vi.mock` is hoisted above module code,
// so the shared mock refs are created via `vi.hoisted`. The mocked `send`
// returns a GetProducts response whose `PriceList` entries are boxed `String`
// OBJECTS (`new String(...)`), reproducing the real pinned-SDK shape that caused
// the bug: a primitive-string-only parser drops every entry.
const { sendMock, capturedInputs } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  capturedInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@aws-sdk/client-pricing', () => {
  class PricingClient {
    send = sendMock;
  }
  class GetProductsCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
      capturedInputs.push(input);
    }
  }
  return { PricingClient, GetProductsCommand };
});

import { parsePriceListItem, fetchRateMap } from '../src/cost/priceList.js';

/** A realistic compute product JSON (omics instance type, Instance-hrs). */
function computeProductJson(resourceType: string, usd: string): string {
  return JSON.stringify({
    product: {
      productFamily: 'Compute',
      attributes: { resourceType },
    },
    terms: {
      OnDemand: {
        'SKU123.JRTCKXETXF': {
          priceDimensions: {
            'SKU123.JRTCKXETXF.6YS6EN2CT7': {
              unit: 'Instance-hrs',
              pricePerUnit: { USD: usd },
            },
          },
        },
      },
    },
  });
}

/** A realistic storage product JSON (Dynamic Run Storage, GB-Hours). */
function storageProductJson(resourceType: string, usd: string): string {
  return JSON.stringify({
    product: {
      productFamily: 'Compute',
      attributes: { resourceType },
    },
    terms: {
      OnDemand: {
        'SKU999.JRTCKXETXF': {
          priceDimensions: {
            'SKU999.JRTCKXETXF.6YS6EN2CT7': {
              unit: 'GB-Hours',
              pricePerUnit: { USD: usd },
            },
          },
        },
      },
    },
  });
}

describe('parsePriceListItem', () => {
  it('parses a primitive-string compute product into a ParsedRate', () => {
    const json = computeProductJson('omics.r.2xlarge', '0.5760000000');
    expect(parsePriceListItem(json)).toEqual({
      resourceType: 'omics.r.2xlarge',
      pricePerUnit: 0.576,
      unit: 'Instance-hrs',
    });
  });

  it('parses a boxed-String compute product identically to its primitive form', () => {
    const json = computeProductJson('omics.r.2xlarge', '0.5760000000');
    const boxed = new String(json) as unknown as string;
    expect(parsePriceListItem(boxed)).toEqual({
      resourceType: 'omics.r.2xlarge',
      pricePerUnit: 0.576,
      unit: 'Instance-hrs',
    });
  });

  it('returns null for malformed (non-JSON) input', () => {
    expect(parsePriceListItem('not json {')).toBeNull();
  });
});

describe('fetchRateMap (boxed-String regression guard)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    capturedInputs.length = 0;
  });

  it('extracts rates when the SDK returns PriceList entries as boxed String objects', async () => {
    const compute = new String(computeProductJson('omics.r.2xlarge', '0.5760000000'));
    const storage = new String(storageProductJson('Dynamic Run Storage', '0.0001315068'));

    sendMock.mockResolvedValue({ PriceList: [compute, storage], NextToken: undefined });

    const result = await fetchRateMap('us-east-1');

    // Both a compute and a storage product must survive — a primitive-string-only
    // parser (the pre-fix `typeof raw !== 'string'` skip) would return {} here.
    expect(result.currency).toBe('USD');
    expect(result.rates['omics.r.2xlarge']).toEqual({
      pricePerUnit: 0.576,
      unit: 'Instance-hrs',
    });
    expect(result.rates['Dynamic Run Storage']).toEqual({
      pricePerUnit: 0.0001315068,
      unit: 'GB-Hours',
    });
    expect(Object.keys(result.rates)).toHaveLength(2);
  });

  it('paginates across NextToken, accumulating boxed-String entries from every page', async () => {
    const page1 = new String(computeProductJson('omics.c.large', '0.1000000000'));
    const page2 = new String(storageProductJson('Dynamic Run Storage', '0.0001315068'));

    sendMock
      .mockResolvedValueOnce({ PriceList: [page1], NextToken: 'tok-2' })
      .mockResolvedValueOnce({ PriceList: [page2], NextToken: undefined });

    const result = await fetchRateMap('us-east-1');

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(result.rates['omics.c.large']).toEqual({ pricePerUnit: 0.1, unit: 'Instance-hrs' });
    expect(result.rates['Dynamic Run Storage']).toEqual({
      pricePerUnit: 0.0001315068,
      unit: 'GB-Hours',
    });
  });
});
