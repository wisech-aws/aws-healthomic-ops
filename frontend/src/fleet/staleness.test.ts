import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Run, RunStatus } from '../api/types';
import { NON_TERMINAL_STATUSES, evaluateStaleness } from './staleness';

/** All run statuses (mirrors `RunStatus`). */
const ALL_STATUSES: readonly RunStatus[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'DELETED',
  'CANCELLED',
  'FAILED',
];

const TERMINAL_STATUSES: readonly RunStatus[] = ALL_STATUSES.filter(
  (s) => !NON_TERMINAL_STATUSES.has(s),
);
const NON_TERMINAL: readonly RunStatus[] = ALL_STATUSES.filter((s) =>
  NON_TERMINAL_STATUSES.has(s),
);

const DEFAULT_THRESHOLD_MS = 60 * 60 * 1000;

let counter = 0;

/** Build a {@link Run} with overridable fields and a unique default id. */
function makeRun(overrides: Partial<Run> = {}): Run {
  counter += 1;
  return {
    runId: `run-${counter}`,
    status: 'RUNNING',
    name: `run-${counter}`,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 9.2 — Property test for stale-run detection.
//
// Property 15: Staleness flags only quiet non-terminal runs.
// For any Run, any thresholdMs > 0, and any now, evaluateStaleness returns
// stale = true iff the run's status is non-terminal, its updatedAt is
// parseable, and now − updatedAt > thresholdMs; terminal statuses yield
// stale = false, reason = 'terminal'; unparseable updatedAt yields
// stale = false, reason = 'unknown'; otherwise reason = 'active-no-progress'
// and ageMs = now − updatedAt (null when updatedAt is unparseable).
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 10.1, 10.3**
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

/** A positive threshold, from one second up to one week. */
const thresholdArb: fc.Arbitrary<number> = fc.integer({
  min: 1_000,
  max: 7 * 24 * 60 * 60 * 1000,
});

/** Any status (terminal or non-terminal). */
const statusArb: fc.Arbitrary<RunStatus> = fc.constantFrom(...ALL_STATUSES);
const terminalStatusArb: fc.Arbitrary<RunStatus> =
  fc.constantFrom(...TERMINAL_STATUSES);
const nonTerminalStatusArb: fc.Arbitrary<RunStatus> =
  fc.constantFrom(...NON_TERMINAL);

/** An `updatedAt` that is present but unparseable. */
const unparseableArb: fc.Arbitrary<string> = fc.constantFrom(
  '',
  'not-a-date',
  'never',
  'yesterday',
  '2024-13-45T99:99:99Z',
);

describe('evaluateStaleness — Property 15: flags only quiet non-terminal runs', () => {
  it('flags stale iff non-terminal AND parseable updatedAt AND now − updatedAt > threshold', () => {
    fc.assert(
      fc.property(
        statusArb,
        isoArb,
        thresholdArb,
        nowArb,
        (status, updatedAt, thresholdMs, now) => {
          const result = evaluateStaleness(
            makeRun({ status, updatedAt }),
            thresholdMs,
            now,
          );
          const isNonTerminal = NON_TERMINAL_STATUSES.has(status);
          const ageMs = now - Date.parse(updatedAt);
          const expectedStale = isNonTerminal && ageMs > thresholdMs;
          expect(result.stale).toBe(expectedStale);
        },
      ),
    );
  });

  it('terminal status => stale:false, reason:terminal, ageMs:null (regardless of updatedAt)', () => {
    fc.assert(
      fc.property(
        terminalStatusArb,
        fc.oneof(isoArb, unparseableArb),
        thresholdArb,
        nowArb,
        (status, updatedAt, thresholdMs, now) => {
          const result = evaluateStaleness(
            makeRun({ status, updatedAt }),
            thresholdMs,
            now,
          );
          expect(result.stale).toBe(false);
          expect(result.reason).toBe('terminal');
          expect(result.ageMs).toBeNull();
        },
      ),
    );
  });

  it('non-terminal with unparseable updatedAt => stale:false, reason:unknown, ageMs:null', () => {
    fc.assert(
      fc.property(
        nonTerminalStatusArb,
        unparseableArb,
        thresholdArb,
        nowArb,
        (status, updatedAt, thresholdMs, now) => {
          const result = evaluateStaleness(
            makeRun({ status, updatedAt }),
            thresholdMs,
            now,
          );
          expect(result.stale).toBe(false);
          expect(result.reason).toBe('unknown');
          expect(result.ageMs).toBeNull();
        },
      ),
    );
  });

  it('non-terminal with parseable updatedAt => reason:active-no-progress and ageMs = now − updatedAt', () => {
    fc.assert(
      fc.property(
        nonTerminalStatusArb,
        isoArb,
        thresholdArb,
        nowArb,
        (status, updatedAt, thresholdMs, now) => {
          const result = evaluateStaleness(
            makeRun({ status, updatedAt }),
            thresholdMs,
            now,
          );
          expect(result.reason).toBe('active-no-progress');
          expect(result.ageMs).toBe(now - Date.parse(updatedAt));
        },
      ),
    );
  });

  it('is deterministic for fixed inputs', () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.oneof(isoArb, unparseableArb),
        thresholdArb,
        nowArb,
        (status, updatedAt, thresholdMs, now) => {
          const run = makeRun({ status, updatedAt });
          expect(evaluateStaleness(run, thresholdMs, now)).toEqual(
            evaluateStaleness(run, thresholdMs, now),
          );
        },
      ),
    );
  });

  it('falls back to the one-hour default threshold when thresholdMs is non-positive or non-finite', () => {
    const badThresholdArb = fc.constantFrom(
      0,
      -1,
      -60_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    );
    fc.assert(
      fc.property(
        nonTerminalStatusArb,
        isoArb,
        badThresholdArb,
        nowArb,
        (status, updatedAt, thresholdMs, now) => {
          const result = evaluateStaleness(
            makeRun({ status, updatedAt }),
            thresholdMs,
            now,
          );
          const ageMs = now - Date.parse(updatedAt);
          expect(result.stale).toBe(ageMs > DEFAULT_THRESHOLD_MS);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — specific examples and boundary cases (Req 9.1–9.4, 10.1, 10.3).
// ---------------------------------------------------------------------------

describe('evaluateStaleness — examples and edge cases', () => {
  const now = Date.parse('2024-06-01T12:00:00.000Z');

  it('flags a non-terminal run gone quiet past the default hour (Req 9.1, 9.2)', () => {
    const run = makeRun({
      status: 'RUNNING',
      updatedAt: '2024-06-01T10:30:00.000Z', // 90 min ago
    });
    const result = evaluateStaleness(run, undefined, now);
    expect(result.stale).toBe(true);
    expect(result.reason).toBe('active-no-progress');
    expect(result.ageMs).toBe(90 * 60 * 1000);
  });

  it('does not flag a non-terminal run still fresh within the threshold (Req 9.1)', () => {
    const run = makeRun({
      status: 'RUNNING',
      updatedAt: '2024-06-01T11:30:00.000Z', // 30 min ago
    });
    const result = evaluateStaleness(run, undefined, now);
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('active-no-progress');
    expect(result.ageMs).toBe(30 * 60 * 1000);
  });

  it('does not flag exactly at the threshold boundary (strict >) (Req 9.1)', () => {
    const run = makeRun({
      status: 'RUNNING',
      updatedAt: '2024-06-01T11:00:00.000Z', // exactly 1h ago
    });
    const result = evaluateStaleness(run, undefined, now);
    expect(result.stale).toBe(false);
    expect(result.ageMs).toBe(DEFAULT_THRESHOLD_MS);
  });

  it('never flags a terminal run and records reason terminal (Req 9.3)', () => {
    for (const status of TERMINAL_STATUSES) {
      const run = makeRun({ status, updatedAt: '2020-01-01T00:00:00.000Z' });
      const result = evaluateStaleness(run, undefined, now);
      expect(result.stale).toBe(false);
      expect(result.reason).toBe('terminal');
      expect(result.ageMs).toBeNull();
    }
  });

  it('treats an absent/null status as terminal (not stuck)', () => {
    const result = evaluateStaleness(
      makeRun({ status: null, updatedAt: '2020-01-01T00:00:00.000Z' }),
      undefined,
      now,
    );
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('terminal');
  });

  it('does not flag when updatedAt is unparseable and records reason unknown (Req 9.4, 10.3)', () => {
    const run = makeRun({ status: 'RUNNING', updatedAt: 'not-a-date' });
    const result = evaluateStaleness(run, undefined, now);
    expect(result.stale).toBe(false);
    expect(result.reason).toBe('unknown');
    expect(result.ageMs).toBeNull();
  });

  it('honours a custom positive threshold', () => {
    const run = makeRun({
      status: 'PENDING',
      updatedAt: '2024-06-01T11:55:00.000Z', // 5 min ago
    });
    // 1-minute threshold => 5 min old is stale.
    expect(evaluateStaleness(run, 60 * 1000, now).stale).toBe(true);
    // 10-minute threshold => 5 min old is fresh.
    expect(evaluateStaleness(run, 10 * 60 * 1000, now).stale).toBe(false);
  });
});
