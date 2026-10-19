import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanInput, runNonInteractive } from '../src/nonInteractiveDriver.mjs';
import { estimate, ESTIMATE_DISCLAIMER } from '../src/estimationCore.mjs';
import { INSTANCE_SPECS } from '../src/instanceSpecs.mjs';
import { renderEstimate } from '../src/render.mjs';

function fakeFetchRateMap() {
  return async () => ({
    rates: {
      'omics.m.large': { pricePerUnit: 1.0, unit: 'Instance-hrs' },
      'Run Storage': { pricePerUnit: 0.5, unit: 'GB-Hours' },
    },
    currency: 'USD',
    retrievedAt: '2024-01-01T00:00:00.000Z',
  });
}

describe('validatePlanInput', () => {
  test('accepts a well-formed input', () => {
    const result = validatePlanInput({
      steps: [{ label: 'align', instanceType: 'omics.m.large', runtime: '2h', scatter: 3 }],
      storage: { mode: 'STATIC', sizeGiB: '100', runtime: '10h' },
    });
    assert.ok(!('error' in result));
    assert.equal(result.steps[0].estimatedRuntimeHours, 2);
    assert.equal(result.steps[0].scatterWidth, 3);
    assert.equal(result.storage.sizeGiB, 100);
    assert.equal(result.storage.runRuntimeHours, 10);
  });

  test('rejects missing steps', () => {
    const result = validatePlanInput({ storage: null });
    assert.ok('error' in result);
  });

  test('rejects an invalid runtime field, naming the field', () => {
    const result = validatePlanInput({
      steps: [{ instanceType: 'omics.m.large', runtime: 'abc', scatter: 1 }],
    });
    assert.ok('error' in result);
    assert.match(result.error, /runtime/);
  });

  test('allows omitted storage', () => {
    const result = validatePlanInput({
      steps: [{ instanceType: 'omics.m.large', runtime: '1h', scatter: 1 }],
    });
    assert.ok(!('error' in result));
    assert.equal(result.storage, null);
  });
});

describe('runNonInteractive', () => {
  test('fixture input + stubbed rate map -> deterministic estimate with exact math', async () => {
    const inputJson = {
      steps: [{ label: 'align', instanceType: 'omics.m.large', runtime: '2h', scatter: 3 }],
      storage: { mode: 'STATIC', sizeGiB: '10', runtime: '1h' },
    };
    const { exitCode, output } = await runNonInteractive({
      inputFile: null,
      region: 'us-east-1',
      pricingClient: {},
      json: true,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderEstimate,
      readStdin: async () => JSON.stringify(inputJson),
    });

    assert.equal(exitCode, 0);
    const result = JSON.parse(output);
    // rate $1.00/hr, runtime 2h, scatter 3 -> compute cost $6.00
    const computeItem = result.lineItems.find((i) => i.kind === 'COMPUTE');
    assert.equal(computeItem.cost, 6);
    assert.equal(result.disclaimer, ESTIMATE_DISCLAIMER);
  });

  test('invalid field -> non-zero exit and a message naming the field', async () => {
    const inputJson = {
      steps: [{ instanceType: 'omics.m.large', runtime: 'not-a-duration', scatter: 1 }],
    };
    const { exitCode, output } = await runNonInteractive({
      inputFile: null,
      region: 'us-east-1',
      pricingClient: {},
      json: true,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderEstimate,
      readStdin: async () => JSON.stringify(inputJson),
    });
    assert.notEqual(exitCode, 0);
    assert.match(output, /runtime/);
  });

  test('--json output includes the EstimateResult shape fields', async () => {
    const inputJson = {
      steps: [{ instanceType: 'omics.m.large', runtime: '1h', scatter: 1 }],
    };
    const { output } = await runNonInteractive({
      inputFile: null,
      region: 'us-east-1',
      pricingClient: {},
      json: true,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderEstimate,
      readStdin: async () => JSON.stringify(inputJson),
    });
    const result = JSON.parse(output);
    for (const field of ['lineItems', 'total', 'partial', 'assumptions', 'disclaimer', 'region', 'currency', 'retrievedAt']) {
      assert.ok(field in result, `missing field: ${field}`);
    }
  });

  test('malformed JSON input -> non-zero exit, clear error', async () => {
    const { exitCode, output } = await runNonInteractive({
      inputFile: null,
      region: 'us-east-1',
      pricingClient: {},
      json: true,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderEstimate,
      readStdin: async () => 'not json {{{',
    });
    assert.notEqual(exitCode, 0);
    assert.match(output, /JSON/);
  });
});
