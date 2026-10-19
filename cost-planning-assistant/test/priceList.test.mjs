import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceListItem, fetchRateMap } from '../src/priceList.mjs';

function fixturePayload({ resourceType, unit, usd, productFamily = 'Compute' }) {
  return JSON.stringify({
    product: { productFamily, attributes: { resourceType } },
    terms: {
      OnDemand: {
        term1: {
          priceDimensions: {
            dim1: { unit, pricePerUnit: { USD: usd } },
          },
        },
      },
    },
  });
}

describe('parsePriceListItem', () => {
  test('parses a valid compute entry', () => {
    const payload = fixturePayload({ resourceType: 'omics.m.large', unit: 'Instance-hrs', usd: '0.192' });
    const result = parsePriceListItem(payload);
    assert.deepEqual(result, { resourceType: 'omics.m.large', pricePerUnit: 0.192, unit: 'Instance-hrs' });
  });

  test('parses a valid Run Storage entry', () => {
    const payload = fixturePayload({ resourceType: 'Run Storage', unit: 'GB-Hours', usd: '0.021' });
    const result = parsePriceListItem(payload);
    assert.deepEqual(result, { resourceType: 'Run Storage', pricePerUnit: 0.021, unit: 'GB-Hours' });
  });

  test('parses a valid Dynamic Run Storage entry', () => {
    const payload = fixturePayload({ resourceType: 'Dynamic Run Storage', unit: 'GB-Hours', usd: '0.033' });
    const result = parsePriceListItem(payload);
    assert.deepEqual(result, { resourceType: 'Dynamic Run Storage', pricePerUnit: 0.033, unit: 'GB-Hours' });
  });

  test('skips an out-of-scope resourceType (Ephemeral Storage)', () => {
    const payload = fixturePayload({ resourceType: 'Ephemeral Storage', unit: 'GB-Hours', usd: '0.01' });
    assert.equal(parsePriceListItem(payload), null);
  });

  test('skips a non-Compute productFamily', () => {
    const payload = fixturePayload({
      resourceType: 'omics.m.large',
      unit: 'Instance-hrs',
      usd: '0.1',
      productFamily: 'Storage',
    });
    assert.equal(parsePriceListItem(payload), null);
  });

  test('skips a malformed (non-JSON) entry without throwing', () => {
    assert.doesNotThrow(() => {
      assert.equal(parsePriceListItem('not json'), null);
    });
  });

  test('skips an entry missing terms.OnDemand', () => {
    const payload = JSON.stringify({
      product: { productFamily: 'Compute', attributes: { resourceType: 'omics.m.large' } },
    });
    assert.equal(parsePriceListItem(payload), null);
  });

  test('coerces a boxed String object before JSON.parse', () => {
    const boxed = new String(
      fixturePayload({ resourceType: 'omics.m.large', unit: 'Instance-hrs', usd: '0.192' }),
    );
    assert.equal(typeof boxed, 'object');
    const result = parsePriceListItem(boxed);
    assert.deepEqual(result, { resourceType: 'omics.m.large', pricePerUnit: 0.192, unit: 'Instance-hrs' });
  });
});

describe('fetchRateMap with a stubbed client', () => {
  test('aggregates valid entries and skips out-of-scope/malformed ones, no real network call', async () => {
    const entries = [
      new String(fixturePayload({ resourceType: 'omics.m.large', unit: 'Instance-hrs', usd: '0.192' })),
      new String(fixturePayload({ resourceType: 'Run Storage', unit: 'GB-Hours', usd: '0.021' })),
      new String(fixturePayload({ resourceType: 'Dynamic Run Storage', unit: 'GB-Hours', usd: '0.033' })),
      new String(fixturePayload({ resourceType: 'Ephemeral Storage', unit: 'GB-Hours', usd: '0.01' })),
      new String('not valid json {{{'),
    ];

    let sendCalls = 0;
    const fakePricingClient = {
      send: async () => {
        sendCalls += 1;
        return { PriceList: entries, NextToken: undefined };
      },
    };

    const result = await fetchRateMap({ region: 'us-east-1', pricingClient: fakePricingClient });

    assert.equal(sendCalls, 1);
    assert.deepEqual(Object.keys(result.rates).sort(), ['Dynamic Run Storage', 'Run Storage', 'omics.m.large']);
    assert.equal(result.rates['omics.m.large'].pricePerUnit, 0.192);
    assert.equal(result.rates['omics.m.large'].unit, 'Instance-hrs');
    assert.equal(result.rates['Run Storage'].pricePerUnit, 0.021);
    assert.equal(result.rates['Dynamic Run Storage'].pricePerUnit, 0.033);
    assert.equal(result.currency, 'USD');
    assert.ok(!Number.isNaN(Date.parse(result.retrievedAt)));
  });

  test('paginates via NextToken and aggregates both pages', async () => {
    const page1Entry = new String(
      fixturePayload({ resourceType: 'omics.m.large', unit: 'Instance-hrs', usd: '0.192' }),
    );
    const page2Entry = new String(
      fixturePayload({ resourceType: 'omics.c.xlarge', unit: 'Instance-hrs', usd: '0.3' }),
    );

    const calls = [];
    const fakePricingClient = {
      send: async (cmd) => {
        calls.push(cmd.input.NextToken);
        if (calls.length === 1) {
          return { PriceList: [page1Entry], NextToken: 'token-page-2' };
        }
        return { PriceList: [page2Entry], NextToken: undefined };
      },
    };

    const result = await fetchRateMap({ region: 'us-east-1', pricingClient: fakePricingClient });

    assert.equal(calls.length, 2);
    assert.equal(calls[0], undefined);
    assert.equal(calls[1], 'token-page-2');
    assert.deepEqual(Object.keys(result.rates).sort(), ['omics.c.xlarge', 'omics.m.large']);
  });

  test('requires no AWS credentials since the client is injected', async () => {
    const fakePricingClient = {
      send: async () => ({ PriceList: [], NextToken: undefined }),
    };
    const result = await fetchRateMap({ region: 'us-east-1', pricingClient: fakePricingClient });
    assert.deepEqual(result.rates, {});
  });
});
