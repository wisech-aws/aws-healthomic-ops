import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatRelativeTime, formatAbsoluteTime } from './relativeTime';

/** A fixed reference instant used across the unit boundary cases. */
const NOW = Date.parse('2024-06-01T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An ISO string `elapsed` ms before NOW. */
function ago(elapsed: number): string {
  return new Date(NOW - elapsed).toISOString();
}

describe('formatRelativeTime — unit boundary cases', () => {
  it("is 'just now' at exactly 0s elapsed and for any sub-60s elapsed", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(1 * SECOND), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe('just now');
  });

  it("treats a future timestamp as 'just now' rather than fabricating a value", () => {
    expect(formatRelativeTime(new Date(NOW + HOUR).toISOString(), NOW)).toBe(
      'just now',
    );
  });

  it("rolls over to '1m ago' at exactly 60s", () => {
    expect(formatRelativeTime(ago(60 * SECOND), NOW)).toBe('1m ago');
  });

  it('formats whole minutes under an hour', () => {
    expect(formatRelativeTime(ago(5 * MINUTE), NOW)).toBe('5m ago');
    expect(formatRelativeTime(ago(59 * MINUTE), NOW)).toBe('59m ago');
    // 90s floors to 1m, not 2.
    expect(formatRelativeTime(ago(90 * SECOND), NOW)).toBe('1m ago');
  });

  it("rolls over to '1h ago' at exactly 3600s", () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe('1h ago');
  });

  it('formats whole hours under a day', () => {
    expect(formatRelativeTime(ago(2 * HOUR), NOW)).toBe('2h ago');
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe('23h ago');
  });

  it("rolls over to '1 day ago' (singular) at exactly 86400s", () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe('1 day ago');
  });

  it('formats multiple days (plural)', () => {
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe('2 days ago');
    expect(formatRelativeTime(ago(30 * DAY), NOW)).toBe('30 days ago');
  });

  it("returns the dash sentinel for null/undefined/''/unparseable", () => {
    expect(formatRelativeTime(null, NOW)).toBe('—');
    expect(formatRelativeTime(undefined, NOW)).toBe('—');
    expect(formatRelativeTime('', NOW)).toBe('—');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
  });
});

describe('formatAbsoluteTime', () => {
  it('returns the toLocaleString() value for a parseable timestamp', () => {
    const iso = '2024-06-01T12:00:00.000Z';
    expect(formatAbsoluteTime(iso)).toBe(new Date(Date.parse(iso)).toLocaleString());
  });

  it("returns null for null/undefined/''/unparseable", () => {
    expect(formatAbsoluteTime(null)).toBeNull();
    expect(formatAbsoluteTime(undefined)).toBeNull();
    expect(formatAbsoluteTime('')).toBeNull();
    expect(formatAbsoluteTime('not-a-date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property test — honest about the unknown, monotone, deterministic.
//
// Mirrors the fast-check style in duration.test.ts:
//  - unparseable/absent input is ALWAYS the dash sentinel '—',
//  - the relative "bucket" is monotone non-decreasing in elapsed time (more
//    elapsed => an equal-or-coarser bucket), and
//  - output is deterministic for a fixed `now`.
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

/** Absent or clearly unparseable inputs — the exact set that must yield '—'. */
const unparseableArb: fc.Arbitrary<string | null | undefined> =
  fc.constantFrom<string | null | undefined>(
    null,
    undefined,
    '',
    'not-a-date',
    'never',
    'yesterday',
  );

/**
 * Maps a relative string to an ordinal bucket rank. A larger rank means a
 * coarser/older bucket. Used to assert monotonicity.
 */
function bucketRank(label: string): number {
  if (label === 'just now') return 0;
  if (label.endsWith('m ago')) return 1;
  if (label.endsWith('h ago')) return 2;
  // '<n> day ago' / '<n> days ago'
  return 3;
}

describe('formatRelativeTime — Property: honest, monotone, deterministic', () => {
  it("always returns '—' for absent/unparseable input, for any now", () => {
    fc.assert(
      fc.property(unparseableArb, nowArb, (iso, now) => {
        expect(formatRelativeTime(iso, now)).toBe('—');
      }),
      { numRuns: 200 },
    );
  });

  it('bucket rank is monotone non-decreasing as elapsed time grows (fixed now)', () => {
    fc.assert(
      fc.property(isoArb, isoArb, nowArb, (a, b, now) => {
        const msA = Date.parse(a);
        const msB = Date.parse(b);
        // Order so `older` has the larger elapsed (i.e. the smaller epoch ms).
        const [older, newer] = msA <= msB ? [a, b] : [b, a];
        const rankOlder = bucketRank(formatRelativeTime(older, now));
        const rankNewer = bucketRank(formatRelativeTime(newer, now));
        expect(rankOlder).toBeGreaterThanOrEqual(rankNewer);
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic for a fixed now (same inputs, same output)', () => {
    fc.assert(
      fc.property(fc.oneof(isoArb, unparseableArb), nowArb, (iso, now) => {
        expect(formatRelativeTime(iso, now)).toBe(formatRelativeTime(iso, now));
      }),
      { numRuns: 200 },
    );
  });

  it('never fabricates a value: parseable input yields a known bucket shape', () => {
    fc.assert(
      fc.property(isoArb, nowArb, (iso, now) => {
        const out = formatRelativeTime(iso, now);
        const known =
          out === 'just now' ||
          /^\d+m ago$/.test(out) ||
          /^\d+h ago$/.test(out) ||
          /^\d+ days? ago$/.test(out);
        expect(known).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
