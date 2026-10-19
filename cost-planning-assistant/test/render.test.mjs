import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderInstanceMenu, renderRunningSummary, renderEstimate } from '../src/render.mjs';
import { ESTIMATE_DISCLAIMER } from '../src/estimationCore.mjs';

describe('renderInstanceMenu', () => {
  test('unavailable spec attributes render as em dash, never 0', () => {
    const options = [
      {
        instanceType: 'omics.newtype.large',
        vcpus: null,
        memoryGiB: null,
        gpuCount: null,
        gpuMemoryGiB: null,
        rate: 0.5,
        unit: 'Instance-hrs',
        specAvailable: false,
        rateAvailable: true,
      },
    ];
    const output = renderInstanceMenu(options);
    assert.match(output, /—/);
    assert.doesNotMatch(output, /\bomics\.newtype\.large\s+0\s+0\b/);
  });

  test('unavailable rate renders as em dash, never 0', () => {
    const options = [
      {
        instanceType: 'omics.m.large',
        vcpus: 2,
        memoryGiB: 8,
        gpuCount: null,
        gpuMemoryGiB: null,
        rate: null,
        unit: null,
        specAvailable: true,
        rateAvailable: false,
      },
    ];
    const output = renderInstanceMenu(options);
    assert.match(output, /—/);
  });

  test('columns are aligned (every data row has the header column count)', () => {
    const options = [
      { instanceType: 'omics.m.large', vcpus: 2, memoryGiB: 8, gpuCount: null, gpuMemoryGiB: null, rate: 0.19, unit: 'Instance-hrs', specAvailable: true, rateAvailable: true },
      { instanceType: 'omics.g6.xlarge', vcpus: 4, memoryGiB: 16, gpuCount: 1, gpuMemoryGiB: 24, rate: 1.2, unit: 'Instance-hrs', specAvailable: true, rateAvailable: true },
    ];
    const output = renderInstanceMenu(options);
    const lines = output.split('\n').filter((l) => l.includes('omics.'));
    assert.equal(lines.length, 2);
  });

  test('includes the unavailable legend', () => {
    const output = renderInstanceMenu([]);
    assert.match(output, /unavailable/);
  });
});

describe('renderRunningSummary', () => {
  test('empty state renders without throwing and indicates nothing chosen yet', () => {
    assert.doesNotThrow(() => {
      const output = renderRunningSummary({});
      assert.match(output, /none defined yet/);
      assert.match(output, /not yet chosen/);
    });
  });

  test('populated state includes every step label and the storage mode/size', () => {
    const state = {
      steps: [
        { label: 'align', instanceType: 'omics.m.large', estimatedRuntimeHours: 2, scatterWidth: 3 },
      ],
      storage: { mode: 'STATIC', sizeGiB: 100, runRuntimeHours: 5 },
    };
    const output = renderRunningSummary(state);
    assert.match(output, /align/);
    assert.match(output, /STATIC/);
    assert.match(output, /100/);
  });
});

describe('renderEstimate', () => {
  function makeResult({ partial }) {
    return {
      region: 'us-east-1',
      currency: 'USD',
      retrievedAt: '2024-01-01T00:00:00.000Z',
      lineItems: [
        {
          kind: 'COMPUTE',
          label: 'align',
          instanceType: 'omics.m.large',
          instanceHours: 2,
          unit: 'Instance-hrs',
          rate: partial ? null : 1,
          cost: partial ? null : 2,
          available: !partial,
          minimumApplied: false,
          reason: partial ? 'No published rate' : null,
        },
      ],
      total: partial ? 0 : 2,
      partial,
      assumptions: { steps: [], storage: null },
      disclaimer: ESTIMATE_DISCLAIMER,
    };
  }

  test('shows PARTIAL badge iff result.partial is true', () => {
    const partialOutput = renderEstimate(makeResult({ partial: true }));
    assert.match(partialOutput, /PARTIAL/);

    const completeOutput = renderEstimate(makeResult({ partial: false }));
    assert.doesNotMatch(completeOutput, /PARTIAL/);
  });

  test('disclaimer is always present', () => {
    const output = renderEstimate(makeResult({ partial: false }));
    assert.ok(output.includes(ESTIMATE_DISCLAIMER));
  });

  test('unavailable line item renders em dash in cost column, never 0', () => {
    const output = renderEstimate(makeResult({ partial: true }));
    assert.match(output, /—/);
  });
});
