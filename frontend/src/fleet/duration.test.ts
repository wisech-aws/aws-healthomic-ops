import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatDuration, runDuration, durationMs, isRunning } from './duration';

describe('formatDuration', () => {
  it('formats an elapsed span as HH:MM:SS', () => {
    expect(formatDuration((3 * 3600 + 4 * 60 + 5) * 1000)).toBe('03:04:05');
  });

  it('zero-pads sub-minute durations', () => {
    expect(formatDuration(5000)).toBe('00:00:05');
  });

  it('treats negative or non-finite input as zero', () => {
    expect(formatDuration(-1000)).toBe('00:00:00');
    expect(formatDuration(Number.NaN)).toBe('00:00:00');
  });
});

describe('runDuration', () => {
  it('measures between start and stop when both are present', () => {
    expect(
      runDuration('2024-01-01T00:00:00.000Z', '2024-01-01T01:30:00.000Z'),
    ).toBe('01:30:00');
  });

  it('measures against now when the run has not stopped', () => {
    const start = '2024-01-01T00:00:00.000Z';
    const now = Date.parse('2024-01-01T00:00:10.000Z');
    expect(runDuration(start, undefined, now)).toBe('00:00:10');
  });

  it('returns a placeholder when there is no start time', () => {
    expect(runDuration(undefined, undefined)).toBe('—');
    expect(runDuration(null, '2024-01-01T01:00:00.000Z')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Task 1.2 — Property test for duration primitives.
//
// Property 1: Duration is non-negative, monotone, and honest about the unknown.
// For any pair of startedAt/stoppedAt values and any now, durationMs returns
// null iff startedAt is absent or unparseable; otherwise it returns a value
// >= 0 that equals stoppedAt − startedAt when both are present and parseable,
// and now − startedAt (clamped at 0) when stoppedAt is absent.
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 10.1, 10.3**
// ---------------------------------------------------------------------------

/** Epoch-ms range kept well inside the safe Date range so ISO round-trips. */
const EPOCH_MIN = Date.parse('2000-01-01T00:00:00.000Z');
const EPOCH_MAX = Date.parse('2035-01-01T00:00:00.000Z');

/** A parseable ISO-8601 timestamp derived from an epoch-ms integer. */
const isoArb: fc.Arbitrary<string> = fc
  .integer({ min: EPOCH_MIN, max: EPOCH_MAX })
  .map((ms) => new Date(ms).toISOString());

/** A `now` value spanning the same window (as epoch ms). */
const nowArb: fc.Arbitrary<number> = fc.integer({
  min: EPOCH_MIN,
  max: EPOCH_MAX,
});

/**
 * A `startedAt` that is absent or unparseable — the exact set for which
 * durationMs must return null. Covers null, undefined, empty string, and
 * clearly non-date text.
 */
const missingStartArb: fc.Arbitrary<string | null | undefined> =
  fc.constantFrom<string | null | undefined>(
    null,
    undefined,
    '',
    'not-a-date',
    'never',
  );

/** A `stoppedAt` slot: present-parseable, or absent (null/undefined). */
const maybeIsoArb: fc.Arbitrary<string | null | undefined> = fc.option(isoArb, {
  nil: undefined,
});

describe('durationMs — Property 1: non-negative, monotone, honest about the unknown', () => {
  it('returns null iff startedAt is absent or unparseable', () => {
    fc.assert(
      fc.property(missingStartArb, maybeIsoArb, nowArb, (start, stop, now) => {
        expect(durationMs(start, stop, now)).toBeNull();
      }),
    );
  });

  it('returns a non-negative number whenever startedAt is parseable (never negative even when stop < start)', () => {
    fc.assert(
      fc.property(isoArb, maybeIsoArb, nowArb, (start, stop, now) => {
        const ms = durationMs(start, stop, now);
        expect(ms).not.toBeNull();
        expect(ms as number).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('equals stoppedAt − startedAt, clamped at 0, when both are present and parseable', () => {
    fc.assert(
      fc.property(isoArb, isoArb, nowArb, (start, stop, now) => {
        const expected = Math.max(0, Date.parse(stop) - Date.parse(start));
        expect(durationMs(start, stop, now)).toBe(expected);
      }),
    );
  });

  it('measures a running item (no stop) against now, clamped at 0', () => {
    fc.assert(
      fc.property(isoArb, nowArb, (start, now) => {
        const expected = Math.max(0, now - Date.parse(start));
        expect(durationMs(start, undefined, now)).toBe(expected);
        expect(durationMs(start, null, now)).toBe(expected);
      }),
    );
  });

  it('is monotone non-decreasing in stoppedAt for a fixed startedAt and now', () => {
    fc.assert(
      fc.property(isoArb, isoArb, isoArb, nowArb, (start, stopA, stopB, now) => {
        // Order the two stop times so `earlier` <= `later`.
        const [earlier, later] =
          Date.parse(stopA) <= Date.parse(stopB)
            ? [stopA, stopB]
            : [stopB, stopA];
        const dEarlier = durationMs(start, earlier, now) as number;
        const dLater = durationMs(start, later, now) as number;
        expect(dLater).toBeGreaterThanOrEqual(dEarlier);
      }),
    );
  });

  it('is deterministic for a fixed now (same inputs, same output)', () => {
    fc.assert(
      fc.property(
        fc.oneof(isoArb, missingStartArb),
        maybeIsoArb,
        nowArb,
        (start, stop, now) => {
          expect(durationMs(start, stop, now)).toBe(durationMs(start, stop, now));
        },
      ),
    );
  });

  it('agrees with isRunning: a running item is exactly one that is started but not stopped', () => {
    fc.assert(
      fc.property(
        fc.oneof(isoArb, missingStartArb),
        maybeIsoArb,
        (start, stop) => {
          const parseableStart =
            start != null && !Number.isNaN(Date.parse(start));
          expect(isRunning(start, stop)).toBe(parseableStart && stop == null);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Task 1.3 — Unit tests for duration edge cases.
// Cover: equal start/stop (= 0), stop-before-start (clamp to 0), running item
// vs fixed now, absent/unparseable startedAt (null).
// _Requirements: 1.2, 1.3, 1.4_
// ---------------------------------------------------------------------------

describe('durationMs — edge cases', () => {
  const now = Date.parse('2024-06-01T12:00:00.000Z');

  it('is 0 when start and stop are equal (Req 1.4 boundary)', () => {
    const t = '2024-01-01T00:00:00.000Z';
    expect(durationMs(t, t, now)).toBe(0);
  });

  it('clamps to 0 when stop is before start rather than returning a negative value (Req 1.4)', () => {
    expect(
      durationMs('2024-01-01T01:00:00.000Z', '2024-01-01T00:00:00.000Z', now),
    ).toBe(0);
  });

  it('measures a running item against a fixed now (Req 1.2)', () => {
    const start = '2024-06-01T11:00:00.000Z';
    // now is 12:00:00Z, so elapsed-so-far is exactly one hour.
    expect(durationMs(start, undefined, now)).toBe(60 * 60 * 1000);
    expect(durationMs(start, null, now)).toBe(60 * 60 * 1000);
  });

  it('falls back to now when stoppedAt is present but unparseable', () => {
    const start = '2024-06-01T11:30:00.000Z';
    expect(durationMs(start, 'not-a-date', now)).toBe(30 * 60 * 1000);
  });

  it('returns null when startedAt is absent (Req 1.3, 10.1)', () => {
    expect(durationMs(undefined, '2024-01-01T01:00:00.000Z', now)).toBeNull();
    expect(durationMs(null, '2024-01-01T01:00:00.000Z', now)).toBeNull();
  });

  it('returns null when startedAt is unparseable (Req 1.3, 10.3)', () => {
    expect(durationMs('not-a-date', '2024-01-01T01:00:00.000Z', now)).toBeNull();
    expect(durationMs('', undefined, now)).toBeNull();
  });

  it('computes a normal closed duration between start and stop (Req 1.1)', () => {
    expect(
      durationMs('2024-01-01T00:00:00.000Z', '2024-01-01T02:30:00.000Z', now),
    ).toBe((2 * 60 + 30) * 60 * 1000);
  });
});

describe('isRunning — edge cases', () => {
  it('is true for a started, not-stopped item', () => {
    expect(isRunning('2024-01-01T00:00:00.000Z', undefined)).toBe(true);
    expect(isRunning('2024-01-01T00:00:00.000Z', null)).toBe(true);
  });

  it('is false once the item has stopped', () => {
    expect(
      isRunning('2024-01-01T00:00:00.000Z', '2024-01-01T01:00:00.000Z'),
    ).toBe(false);
  });

  it('is false when startedAt is absent or unparseable', () => {
    expect(isRunning(undefined, undefined)).toBe(false);
    expect(isRunning(null, undefined)).toBe(false);
    expect(isRunning('not-a-date', undefined)).toBe(false);
  });
});
