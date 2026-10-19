import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONE_MINUTE_HOURS,
  ESTIMATE_DISCLAIMER,
  buildInstanceOptions,
  estimate,
} from '../src/estimationCore.mjs';

describe('buildInstanceOptions', () => {
  test('priced + spec -> fully available', () => {
    const rateMap = { 'omics.m.large': { pricePerUnit: 0.5, unit: 'Instance-hrs' } };
    const specs = { 'omics.m.large': { vcpus: 2, memoryGiB: 8 } };
    const [option] = buildInstanceOptions(rateMap, specs);
    assert.equal(option.instanceType, 'omics.m.large');
    assert.equal(option.vcpus, 2);
    assert.equal(option.memoryGiB, 8);
    assert.equal(option.rate, 0.5);
    assert.equal(option.specAvailable, true);
    assert.equal(option.rateAvailable, true);
  });

  test('priced, no spec -> specAvailable=false, price still present', () => {
    const rateMap = { 'omics.newtype.large': { pricePerUnit: 0.75, unit: 'Instance-hrs' } };
    const [option] = buildInstanceOptions(rateMap, {});
    assert.equal(option.specAvailable, false);
    assert.equal(option.vcpus, null);
    assert.equal(option.memoryGiB, null);
    assert.equal(option.rate, 0.75);
    assert.equal(option.rateAvailable, true);
  });

  test('spec, no price -> rateAvailable=false, spec still present', () => {
    const specs = { 'omics.m.large': { vcpus: 2, memoryGiB: 8 } };
    const [option] = buildInstanceOptions({}, specs);
    assert.equal(option.rateAvailable, false);
    assert.equal(option.rate, null);
    assert.equal(option.vcpus, 2);
    assert.equal(option.memoryGiB, 8);
  });

  test('storage family keys never appear as instance options', () => {
    const rateMap = {
      'omics.m.large': { pricePerUnit: 0.5, unit: 'Instance-hrs' },
      'Run Storage': { pricePerUnit: 0.02, unit: 'GB-Hours' },
      'Dynamic Run Storage': { pricePerUnit: 0.03, unit: 'GB-Hours' },
    };
    const options = buildInstanceOptions(rateMap, {});
    const types = options.map((o) => o.instanceType);
    assert.ok(!types.includes('Run Storage'));
    assert.ok(!types.includes('Dynamic Run Storage'));
    assert.equal(types.length, 1);
  });
});

describe('estimate - compute math', () => {
  test('single step: instanceHours and cost computed exactly', () => {
    const rateMap = { 'omics.m.large': { pricePerUnit: 1.0, unit: 'Instance-hrs' } };
    const result = estimate(
      {
        steps: [
          { label: 'align', instanceType: 'omics.m.large', estimatedRuntimeHours: 2, scatterWidth: 3 },
        ],
        rateMap,
      },
      '2024-01-01T00:00:00.000Z',
    );
    const [item] = result.lineItems;
    assert.equal(item.instanceHours, 6);
    assert.equal(item.cost, 6);
    assert.equal(item.minimumApplied, false);
    assert.equal(item.available, true);
  });

  test('multi-step itemization: each step attributed correctly', () => {
    const rateMap = {
      'omics.m.large': { pricePerUnit: 1.0, unit: 'Instance-hrs' },
      'omics.c.xlarge': { pricePerUnit: 2.0, unit: 'Instance-hrs' },
    };
    const result = estimate(
      {
        steps: [
          { label: 'align', instanceType: 'omics.m.large', estimatedRuntimeHours: 1, scatterWidth: 1 },
          { label: 'call', instanceType: 'omics.c.xlarge', estimatedRuntimeHours: 1, scatterWidth: 2 },
        ],
        rateMap,
      },
      '2024-01-01T00:00:00.000Z',
    );
    assert.equal(result.lineItems.length, 2);
    assert.equal(result.lineItems[0].label, 'align');
    assert.equal(result.lineItems[0].cost, 1);
    assert.equal(result.lineItems[1].label, 'call');
    assert.equal(result.lineItems[1].cost, 4);
  });
});

describe('estimate - storage math', () => {
  test('STATIC storage: gbHours and cost computed exactly, family label correct', () => {
    const rateMap = { 'Run Storage': { pricePerUnit: 0.05, unit: 'GB-Hours' } };
    const result = estimate(
      { steps: [], storage: { mode: 'STATIC', sizeGiB: 100, runRuntimeHours: 10 }, rateMap },
      '2024-01-01T00:00:00.000Z',
    );
    const [item] = result.lineItems;
    assert.equal(item.family, 'Run Storage');
    assert.equal(item.gbHours, 1000);
    assert.equal(item.cost, 50);
    assert.equal(item.available, true);
  });

  test('DYNAMIC storage: family label correct and assumption note present', () => {
    const rateMap = { 'Dynamic Run Storage': { pricePerUnit: 0.03, unit: 'GB-Hours' } };
    const result = estimate(
      { steps: [], storage: { mode: 'DYNAMIC', sizeGiB: 50, runRuntimeHours: 4 }, rateMap },
      '2024-01-01T00:00:00.000Z',
    );
    const [item] = result.lineItems;
    assert.equal(item.family, 'Dynamic Run Storage');
    assert.equal(item.available, true);
    assert.match(item.assumptionNote, /assumption/i);
  });
});

describe('estimate - one-minute-minimum-per-task floor', () => {
  test('sub-minute per-task runtime is floored to 1 minute, per task, before scatter multiply', () => {
    const rateMap = { 'omics.m.large': { pricePerUnit: 1.0, unit: 'Instance-hrs' } };
    const result = estimate(
      {
        steps: [
          {
            label: 'quick',
            instanceType: 'omics.m.large',
            estimatedRuntimeHours: 1 / 120, // 30 seconds
            scatterWidth: 4,
          },
        ],
        rateMap,
      },
      '2024-01-01T00:00:00.000Z',
    );
    const [item] = result.lineItems;
    assert.equal(item.instanceHours, (1 / 60) * 4);
    assert.notEqual(item.instanceHours, (1 / 120) * 4);
    assert.equal(item.minimumApplied, true);
  });

  test('runtime above the floor is unaffected', () => {
    const rateMap = { 'omics.m.large': { pricePerUnit: 1.0, unit: 'Instance-hrs' } };
    const result = estimate(
      {
        steps: [
          { label: 'normal', instanceType: 'omics.m.large', estimatedRuntimeHours: 1, scatterWidth: 5 },
        ],
        rateMap,
      },
      '2024-01-01T00:00:00.000Z',
    );
    const [item] = result.lineItems;
    assert.equal(item.instanceHours, 5);
    assert.equal(item.minimumApplied, false);
  });

  test('property: instanceHours === max(runtimeHours, 1/60) * scatterWidth across a range', () => {
    const rateMap = { 'omics.m.large': { pricePerUnit: 1.0, unit: 'Instance-hrs' } };
    const runtimes = [1 / 600, 1 / 120, ONE_MINUTE_HOURS, 0.5, 1, 10];
    const scatterWidths = [1, 2, 5, 100];
    for (const runtimeHours of runtimes) {
      for (const scatterWidth of scatterWidths) {
        const result = estimate(
          {
            steps: [{ label: 's', instanceType: 'omics.m.large', estimatedRuntimeHours: runtimeHours, scatterWidth }],
            rateMap,
          },
          '2024-01-01T00:00:00.000Z',
        );
        const expected = Math.max(runtimeHours, 1 / 60) * scatterWidth;
        assert.ok(
          Math.abs(result.lineItems[0].instanceHours - expected) < 1e-12,
          `runtime=${runtimeHours}, scatter=${scatterWidth}`,
        );
      }
    }
  });
});

describe('estimate - no-fabrication / partial-total invariant', () => {
  test('total sums only available items; unavailable item contributes no number', () => {
    const rateMap = { 'omics.m.large': { pricePerUnit: 1.0, unit: 'Instance-hrs' } };
    const result = estimate(
      {
        steps: [
          { label: 'priced', instanceType: 'omics.m.large', estimatedRuntimeHours: 1, scatterWidth: 1 },
          { label: 'unpriced', instanceType: 'omics.unknown.large', estimatedRuntimeHours: 1, scatterWidth: 1 },
        ],
        rateMap,
      },
      '2024-01-01T00:00:00.000Z',
    );
    assert.equal(result.total, 1); // only the priced item's cost
    assert.equal(result.partial, true);
    const unavailable = result.lineItems.find((i) => !i.available);
    assert.equal(unavailable.cost, null);
    assert.notEqual(unavailable.cost, 0);
  });

  test('whole-estimate unavailable: no computable line items', () => {
    const result = estimate(
      {
        steps: [
          { label: 'unpriced', instanceType: 'omics.unknown.large', estimatedRuntimeHours: 1, scatterWidth: 1 },
        ],
        rateMap: {},
      },
      '2024-01-01T00:00:00.000Z',
    );
    assert.equal(result.total, 0);
    assert.equal(result.partial, true);
    // caller/render should distinguish "no computable line items" via this check:
    assert.ok(result.lineItems.every((i) => !i.available));
  });
});

describe('estimate - echoed assumptions and disclaimer', () => {
  test('echoes back steps and storage, includes the exact disclaimer', () => {
    const steps = [{ label: 's', instanceType: 'omics.m.large', estimatedRuntimeHours: 1, scatterWidth: 1 }];
    const storage = { mode: 'STATIC', sizeGiB: 1, runRuntimeHours: 1 };
    const rateMap = {
      'omics.m.large': { pricePerUnit: 1, unit: 'Instance-hrs' },
      'Run Storage': { pricePerUnit: 1, unit: 'GB-Hours' },
    };
    const result = estimate({ steps, storage, rateMap }, '2024-01-01T00:00:00.000Z');
    assert.deepEqual(result.assumptions.steps, steps);
    assert.deepEqual(result.assumptions.storage, storage);
    assert.equal(result.disclaimer, ESTIMATE_DISCLAIMER);
  });
});
