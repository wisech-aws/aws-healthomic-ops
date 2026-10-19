import { describe, it, expect } from 'vitest';

import {
  aggregateComputeHours,
  instanceHours,
  ONE_MINUTE_HOURS,
  type TaskLike,
} from '../../src/cost/estimate.js';

// AWS HealthOmics bills compute per task with a one-minute minimum task
// duration charge (see "Run optimization for a private HealthOmics workflow",
// https://docs.aws.amazon.com/omics/latest/dev/workflows-run-optimize.html).
// These tests pin `aggregateComputeHours` to that rule: the floor is applied
// PER TASK, before summing into `byInstanceType`.

function task(startedAt: string, stoppedAt: string, instanceType = 'omics.m.large'): TaskLike {
  return { instanceType, startedAt, stoppedAt };
}

describe('ONE_MINUTE_HOURS', () => {
  it('is exactly 1/60', () => {
    expect(ONE_MINUTE_HOURS).toBe(1 / 60);
  });
});

describe('instanceHours', () => {
  it('returns the raw measured duration, unfloored', () => {
    // 30 seconds => 1/120 hr, well under the one-minute billing floor. This
    // function reports the raw measurement; the floor is applied downstream in
    // aggregateComputeHours.
    const hours = instanceHours('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:30.000Z');
    expect(hours).toBeCloseTo(30 / 3600);
    expect(hours).toBeLessThan(ONE_MINUTE_HOURS);
  });

  it('returns null when either timestamp is missing', () => {
    expect(instanceHours(null, '2024-01-01T00:00:30.000Z')).toBeNull();
    expect(instanceHours('2024-01-01T00:00:00.000Z', null)).toBeNull();
  });
});

describe('aggregateComputeHours — one-minute-minimum billing floor', () => {
  it('floors a sub-minute task to ONE_MINUTE_HOURS', () => {
    // 30-second task: raw duration is 1/120 hr, but HealthOmics bills at least
    // one minute per task.
    const agg = aggregateComputeHours([
      task('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:30.000Z'),
    ]);

    expect(agg.byInstanceType.get('omics.m.large')).toBeCloseTo(ONE_MINUTE_HOURS);
    expect(agg.excludedNoRuntimeCount).toBe(0);
    expect(agg.missingInstanceTypeCount).toBe(0);
  });

  it('leaves a task at or over one minute unaffected by the floor', () => {
    // Exactly one minute: raw === floor, so the result is unchanged either way.
    const exactlyOneMinute = aggregateComputeHours([
      task('2024-01-01T00:00:00.000Z', '2024-01-01T00:01:00.000Z'),
    ]);
    expect(exactlyOneMinute.byInstanceType.get('omics.m.large')).toBeCloseTo(ONE_MINUTE_HOURS);

    // One hour: well over the floor, so the raw measured duration is billed as-is.
    const oneHour = aggregateComputeHours([
      task('2024-01-01T00:00:00.000Z', '2024-01-01T01:00:00.000Z'),
    ]);
    expect(oneHour.byInstanceType.get('omics.m.large')).toBeCloseTo(1);
  });

  it('applies the floor PER TASK before summing, not once on the aggregate', () => {
    // Two sub-minute (30s) tasks of the same instance type must aggregate to
    // 2 x ONE_MINUTE_HOURS, not a single one-minute floor applied to their
    // (otherwise sub-minute) combined raw duration.
    const agg = aggregateComputeHours([
      task('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:30.000Z'),
      task('2024-01-01T01:00:00.000Z', '2024-01-01T01:00:30.000Z'),
    ]);

    expect(agg.byInstanceType.get('omics.m.large')).toBeCloseTo(2 * ONE_MINUTE_HOURS);
  });

  it('does not floor a task with no usable runtime — it stays excluded', () => {
    const agg = aggregateComputeHours([
      { instanceType: 'omics.m.large', startedAt: null, stoppedAt: null },
    ]);

    expect(agg.byInstanceType.has('omics.m.large')).toBe(false);
    expect(agg.excludedNoRuntimeCount).toBe(1);
  });

  it('sums floored and unfloored tasks together per instance type', () => {
    const agg = aggregateComputeHours([
      task('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:10.000Z'), // 10s => floored to 1/60
      task('2024-01-01T01:00:00.000Z', '2024-01-01T02:00:00.000Z'), // 1h => unaffected
    ]);

    expect(agg.byInstanceType.get('omics.m.large')).toBeCloseTo(ONE_MINUTE_HOURS + 1);
  });
});
