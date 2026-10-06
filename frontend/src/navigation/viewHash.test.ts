import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseViewHash, serializeViewHash } from './viewHash';
import type { ViewState } from './viewHash';

// ---------------------------------------------------------------------------
// Unit cases — the recognized scheme and the no-fabrication fallbacks.
// ---------------------------------------------------------------------------

describe('parseViewHash', () => {
  it('parses a run hash into a run state', () => {
    expect(parseViewHash('#/run/r1')).toEqual({ kind: 'run', runId: 'r1' });
  });

  it('parses a run+task hash into a run state with the task', () => {
    expect(parseViewHash('#/run/r1/task/t1')).toEqual({
      kind: 'run',
      runId: 'r1',
      taskId: 't1',
    });
  });

  it('falls back to fleet for empty / bare-hash / unknown inputs', () => {
    for (const input of ['', '#', '#/', '#/garbage', '#/runs/x', '#/run']) {
      expect(parseViewHash(input)).toEqual({ kind: 'fleet' });
    }
  });

  it('falls back to fleet for a run hash with an empty id', () => {
    expect(parseViewHash('#/run/')).toEqual({ kind: 'fleet' });
  });

  it('resolves a missing/empty task id to the run with no task selected', () => {
    expect(parseViewHash('#/run/r1/task')).toEqual({ kind: 'run', runId: 'r1' });
    expect(parseViewHash('#/run/r1/task/')).toEqual({
      kind: 'run',
      runId: 'r1',
    });
  });

  it('ignores an unrecognized trailing shape and keeps the run', () => {
    expect(parseViewHash('#/run/r1/logs/x')).toEqual({
      kind: 'run',
      runId: 'r1',
    });
  });

  it('URL-decodes id segments with reserved characters', () => {
    const runId = 'a/b#c d%e';
    expect(parseViewHash(`#/run/${encodeURIComponent(runId)}`)).toEqual({
      kind: 'run',
      runId,
    });
  });

  it('never throws and never fabricates on a malformed escape sequence', () => {
    // A lone '%' is an invalid escape; decoding must not throw -> fleet.
    expect(() => parseViewHash('#/run/%')).not.toThrow();
    expect(parseViewHash('#/run/%')).toEqual({ kind: 'fleet' });
  });

  it('accepts a hash with no leading slash after #', () => {
    expect(parseViewHash('#run/r1')).toEqual({ kind: 'run', runId: 'r1' });
  });
});

describe('serializeViewHash', () => {
  it('serializes fleet to the root hash', () => {
    expect(serializeViewHash({ kind: 'fleet' })).toBe('#/');
  });

  it('serializes a run and a run+task with URL-encoded ids', () => {
    expect(serializeViewHash({ kind: 'run', runId: 'r1' })).toBe('#/run/r1');
    expect(
      serializeViewHash({ kind: 'run', runId: 'r1', taskId: 't1' }),
    ).toBe('#/run/r1/task/t1');
  });

  it('encodes reserved characters in ids', () => {
    const state: ViewState = { kind: 'run', runId: 'a/b', taskId: 'c d' };
    expect(serializeViewHash(state)).toBe('#/run/a%2Fb/task/c%20d');
  });

  it('treats an empty task id as no task', () => {
    expect(
      serializeViewHash({ kind: 'run', runId: 'r1', taskId: '' }),
    ).toBe('#/run/r1');
  });
});

// ---------------------------------------------------------------------------
// Property tests — round-trip, idempotence, and total (never-throws).
// ---------------------------------------------------------------------------

/** Non-empty id strings, including reserved characters so encoding matters. */
const idArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((s) => s.length > 0);

/** An arbitrary ViewState: fleet, run, or run+task. */
const viewStateArb: fc.Arbitrary<ViewState> = fc.oneof(
  fc.constant<ViewState>({ kind: 'fleet' }),
  idArb.map<ViewState>((runId) => ({ kind: 'run', runId })),
  fc.record({ runId: idArb, taskId: idArb }).map<ViewState>(({ runId, taskId }) => ({
    kind: 'run',
    runId,
    taskId,
  })),
);

describe('viewHash — round-trip and totality properties', () => {
  it('parseViewHash(serializeViewHash(state)) deep-equals state', () => {
    fc.assert(
      fc.property(viewStateArb, (state) => {
        expect(parseViewHash(serializeViewHash(state))).toEqual(state);
      }),
      { numRuns: 500 },
    );
  });

  it('serializeViewHash(parseViewHash(x)) is idempotent for any serialized hash', () => {
    fc.assert(
      fc.property(viewStateArb, (state) => {
        const hash = serializeViewHash(state);
        const reparsed = parseViewHash(hash);
        expect(serializeViewHash(reparsed)).toBe(hash);
      }),
      { numRuns: 500 },
    );
  });

  it('parseViewHash never throws on an arbitrary string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseViewHash(s)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('parseViewHash always returns a well-formed ViewState', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const state = parseViewHash(s);
        if (state.kind === 'fleet') {
          expect(Object.keys(state)).toEqual(['kind']);
        } else {
          expect(state.kind).toBe('run');
          expect(typeof state.runId).toBe('string');
          expect(state.runId.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });
});
