import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runInteractive } from '../src/interactiveDriver.mjs';
import { estimate } from '../src/estimationCore.mjs';
import { INSTANCE_SPECS } from '../src/instanceSpecs.mjs';
import { renderInstanceMenu, renderRunningSummary, renderEstimate } from '../src/render.mjs';

/** Build a scripted fake `prompt` that returns queued answers in order. */
function scriptedPrompt(answers) {
  const queue = [...answers];
  return async (question) => {
    if (queue.length === 0) {
      throw new Error(`prompt() called with no more scripted answers (question: "${question}")`);
    }
    return queue.shift();
  };
}

function collectingPrint() {
  const lines = [];
  const print = (text) => lines.push(text);
  return { print, lines };
}

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

describe('runInteractive - Run_Id handoff path', () => {
  test('answering yes to Run_Id prints handoff and does not fetch rates', async () => {
    const { print, lines } = collectingPrint();
    const prompt = scriptedPrompt(['yes']);
    const throwingPricingClient = { send: () => { throw new Error('should not be called'); } };
    const fetchRateMap = async () => {
      throw new Error('fetchRateMap should not be called on the Run_Id handoff path');
    };

    const result = await runInteractive({
      region: 'us-east-1',
      pricingClient: throwingPricingClient,
      prompt,
      print,
      fetchRateMap,
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderInstanceMenu,
      renderRunningSummary,
      renderEstimate,
    });

    assert.equal(result.handoff, true);
    assert.ok(lines.some((l) => /post-run estimator|dist-cost-estimator/.test(l)));
  });
});

describe('runInteractive - recommendation never auto-committed', () => {
  test('an override answer wins over the recommendation', async () => {
    const { print } = collectingPrint();
    const prompt = scriptedPrompt([
      'no', // has Run_Id? no
      'step-1', // label
      'yes', // want a recommendation?
      '2', // minVcpus
      '8', // minMemoryGiB
      'omics.m.large', // override: type the instance type directly instead of accepting recommendation
      '1h', // runtime
      '1', // scatter
      'no', // add another step?
      'STATIC', // storage mode
      '10GiB', // storage size
      '1h', // run runtime
      'yes', // confirm compute
    ]);

    const result = await runInteractive({
      region: 'us-east-1',
      pricingClient: {},
      prompt,
      print,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderInstanceMenu,
      renderRunningSummary,
      renderEstimate,
    });

    assert.equal(result.result.assumptions.steps[0].instanceType, 'omics.m.large');
  });

  test('an explicit confirm (blank answer) uses the recommended type', async () => {
    const { print } = collectingPrint();
    const prompt = scriptedPrompt([
      'no',
      'step-1',
      'yes',
      '2',
      '8',
      '', // blank -> accept the recommendation
      '1h',
      '1',
      'no',
      'STATIC',
      '10GiB',
      '1h',
      'yes',
    ]);

    const result = await runInteractive({
      region: 'us-east-1',
      pricingClient: {},
      prompt,
      print,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderInstanceMenu,
      renderRunningSummary,
      renderEstimate,
    });

    // The only priced+spec'd type meeting {minVcpus:2, minMemoryGiB:8} is omics.m.large
    // (vcpus=2, memoryGiB=8) among the fake rate map's priced types.
    assert.equal(result.result.assumptions.steps[0].instanceType, 'omics.m.large');
  });
});

describe('runInteractive - invalid entry re-prompt', () => {
  test('an invalid runtime re-prompts with a specific message before proceeding', async () => {
    const { print, lines } = collectingPrint();
    const prompt = scriptedPrompt([
      'no',
      'step-1',
      'no', // skip recommendation
      'omics.m.large',
      'not-a-duration', // invalid runtime
      '1h', // valid runtime
      '1',
      'no',
      'STATIC',
      '10GiB',
      '1h',
      'yes',
    ]);

    const result = await runInteractive({
      region: 'us-east-1',
      pricingClient: {},
      prompt,
      print,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderInstanceMenu,
      renderRunningSummary,
      renderEstimate,
    });

    assert.ok(lines.some((l) => /Not valid/.test(l)));
    assert.equal(result.result.assumptions.steps[0].estimatedRuntimeHours, 1);
  });
});

describe('runInteractive - completed flow matches hand-computed estimate', () => {
  test('full scripted flow yields the expected total', async () => {
    const prompt = scriptedPrompt([
      'no',
      'align',
      'no',
      'omics.m.large',
      '2h',
      '3',
      'no',
      'STATIC',
      '10GiB',
      '1h',
      'yes',
    ]);
    const { print } = collectingPrint();

    const result = await runInteractive({
      region: 'us-east-1',
      pricingClient: {},
      prompt,
      print,
      fetchRateMap: fakeFetchRateMap(),
      instanceSpecs: INSTANCE_SPECS,
      estimate,
      renderInstanceMenu,
      renderRunningSummary,
      renderEstimate,
    });

    // compute: rate $1/hr * 2h * scatter 3 = $6; storage: 10GiB * 1h * $0.5/GB-hr = $5
    assert.equal(result.result.total, 11);
  });
});
