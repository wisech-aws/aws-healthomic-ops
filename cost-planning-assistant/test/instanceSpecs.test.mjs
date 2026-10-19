import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCE_SPECS, getSpec, recommendSmallestFit } from '../src/instanceSpecs.mjs';

const NON_GPU_RATIOS = { c: 2, m: 4, r: 8 };
const SIZE_LADDER_VCPUS = {
  large: 2,
  xlarge: 4,
  '2xlarge': 8,
  '4xlarge': 16,
  '8xlarge': 32,
  '12xlarge': 48,
  '16xlarge': 64,
  '24xlarge': 96,
  '32xlarge': 128,
  '48xlarge': 192,
};

function familyLetterOf(instanceType) {
  // omics.<family>.<size>
  const parts = instanceType.split('.');
  return parts[1];
}

describe('INSTANCE_SPECS table invariants', () => {
  test('every non-GPU entry satisfies memoryGiB === vcpus * family ratio', () => {
    for (const [instanceType, spec] of Object.entries(INSTANCE_SPECS)) {
      const family = familyLetterOf(instanceType);
      if (!(family in NON_GPU_RATIOS)) {
        continue; // GPU family; skip (irregular, tested separately)
      }
      const ratio = NON_GPU_RATIOS[family];
      assert.equal(
        spec.memoryGiB,
        spec.vcpus * ratio,
        `${instanceType}: expected memoryGiB === vcpus(${spec.vcpus}) * ${ratio}`,
      );
    }
  });

  test('every non-GPU entry vCPU matches the documented size ladder', () => {
    for (const [instanceType, spec] of Object.entries(INSTANCE_SPECS)) {
      const family = familyLetterOf(instanceType);
      if (!(family in NON_GPU_RATIOS)) {
        continue;
      }
      const size = instanceType.split('.')[2];
      if (!(size in SIZE_LADDER_VCPUS)) {
        continue;
      }
      assert.equal(spec.vcpus, SIZE_LADDER_VCPUS[size], `${instanceType}: unexpected vCPU count`);
    }
  });

  test('the table is frozen at the top level and per-entry', () => {
    assert.throws(() => {
      INSTANCE_SPECS['omics.m.large'] = { vcpus: 999, memoryGiB: 999 };
    }, TypeError);
    const spec = INSTANCE_SPECS['omics.m.large'];
    assert.throws(() => {
      spec.vcpus = 999;
    }, TypeError);
  });
});

describe('getSpec', () => {
  test('returns the exact spec for a known standard type', () => {
    assert.deepEqual(getSpec('omics.m.large'), { vcpus: 2, memoryGiB: 8 });
  });

  test('returns GPU fields for a known GPU type', () => {
    const spec = getSpec('omics.g6.xlarge');
    assert.deepEqual(spec, { vcpus: 4, memoryGiB: 16, gpuCount: 1, gpuMemoryGiB: 24 });
  });

  test('returns null for an unknown instance type (no fabrication)', () => {
    assert.equal(getSpec('omics.nonexistent.large'), null);
  });

  test('returns null for non-string input', () => {
    assert.equal(getSpec(undefined), null);
    assert.equal(getSpec(42), null);
  });
});

describe('recommendSmallestFit', () => {
  const allTypes = Object.keys(INSTANCE_SPECS);

  test('returns smallest-fitting first, ascending, excluding types below the need', () => {
    const result = recommendSmallestFit({ minVcpus: 4 }, allTypes);
    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0);
    for (const instanceType of result) {
      assert.ok(getSpec(instanceType).vcpus >= 4);
    }
    // ascending by vcpus
    const vcpuSeq = result.map((t) => getSpec(t).vcpus);
    for (let i = 1; i < vcpuSeq.length; i += 1) {
      assert.ok(vcpuSeq[i] >= vcpuSeq[i - 1]);
    }
    // the smallest returned vcpus must be the minimum vcpus >= 4 across all candidates
    const minFittingVcpus = Math.min(
      ...allTypes.map((t) => getSpec(t).vcpus).filter((v) => v >= 4),
    );
    assert.equal(vcpuSeq[0], minFittingVcpus);
  });

  test('honors needsGpu and excludes every non-GPU type', () => {
    const result = recommendSmallestFit({ needsGpu: true }, allTypes);
    assert.ok(result.length > 0);
    for (const instanceType of result) {
      const spec = getSpec(instanceType);
      assert.ok(spec.gpuCount > 0, `${instanceType} should have a GPU`);
    }
  });

  test('returns [] when nothing fits', () => {
    const result = recommendSmallestFit({ minVcpus: 999999 }, allTypes);
    assert.deepEqual(result, []);
  });

  test('never returns a bare string/single object -- always an array', () => {
    const result = recommendSmallestFit({ minVcpus: 2 }, allTypes);
    assert.ok(Array.isArray(result));
  });

  test('does not mutate the input array', () => {
    const input = ['omics.m.large', 'omics.c.xlarge', 'omics.r.2xlarge'];
    const copyBefore = [...input];
    recommendSmallestFit({ minVcpus: 2 }, input);
    assert.deepEqual(input, copyBefore);
  });

  test('excludes unknown-spec types without throwing', () => {
    const result = recommendSmallestFit({ minVcpus: 2 }, ['omics.unknown.large', 'omics.m.large']);
    assert.deepEqual(result, ['omics.m.large']);
  });
});
