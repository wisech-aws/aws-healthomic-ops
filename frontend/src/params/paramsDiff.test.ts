/**
 * Property tests for the two-run parameters diff (enhancement 6).
 *
 * Property 12 (task 7.2): `diffRunParameters` is complete, sound, and
 * structurally symmetric — Validates Requirements 6.1, 6.2, 6.3, 6.4.
 * Property 13 (task 7.3): parse errors are surfaced, not swallowed —
 * Validates Requirements 6.5, 6.6, 10.1, 10.3.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseParameters, diffRunParameters, type DiffKind } from './paramsDiff';
import type { Run } from '../api/types';

/** Build a {@link Run} with sensible defaults; `parameters` is overridable. */
function makeRun(partial: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

/**
 * A JSON leaf value: primitives and arrays. Nested plain objects are handled
 * separately by {@link paramsObject} so that `flatten` has something to recurse
 * into; arrays are kept whole by the implementation.
 */
const leafValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { maxLength: 3 }),
);

/**
 * A (possibly nested) parameters object with string keys. Depth is bounded so
 * generation terminates; keys avoid `.` so our independent flatten below is
 * unambiguous against the implementation's dotted-path scheme.
 */
const paramsObject: fc.Arbitrary<Record<string, unknown>> = fc.letrec<{
  node: Record<string, unknown>;
}>((tie) => ({
  node: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 4 }).filter((k) => !k.includes('.')),
    fc.oneof({ maxDepth: 3 }, leafValue, tie('node')),
    { maxKeys: 5 },
  ),
})).node;

/** Independent structural deep-equality (mirrors the module's leaf semantics). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return (
      ak.length === bk.length &&
      ak.every(
        (k) =>
          Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]),
      )
    );
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Independent flatten used only to compute the *expected* key union and leaf
 * values, so Property 12 is not a tautology against the implementation.
 */
function flatten(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    if (isPlainObject(v)) Object.assign(out, flatten(v, path));
    else out[path] = v;
  }
  return out;
}

/** A run whose `parameters` is the JSON encoding of the given object. */
function runWithParams(obj: Record<string, unknown>, workflowId = 'wf'): Run {
  return makeRun({ workflowId, parameters: JSON.stringify(obj) });
}

describe('diffRunParameters — Property 12: complete, sound, symmetric (Req 6.1–6.4)', () => {
  // **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
  it('emits one entry per union key, sorted, with sound classification', () => {
    fc.assert(
      fc.property(paramsObject, paramsObject, (leftObj, rightObj) => {
        const result = diffRunParameters(
          runWithParams(leftObj),
          runWithParams(rightObj),
        );

        const leftFlat = flatten(leftObj);
        const rightFlat = flatten(rightObj);
        const expectedKeys = Array.from(
          new Set([...Object.keys(leftFlat), ...Object.keys(rightFlat)]),
        ).sort();

        // 6.1/6.2: exactly the union of flattened keys, one entry each, sorted.
        const gotKeys = result.entries.map((e) => e.key);
        expect(gotKeys).toEqual(expectedKeys);
        expect(new Set(gotKeys).size).toBe(gotKeys.length);

        // 6.3: classification is sound against independent flatten/deep-equal.
        for (const entry of result.entries) {
          const inLeft = Object.prototype.hasOwnProperty.call(
            leftFlat,
            entry.key,
          );
          const inRight = Object.prototype.hasOwnProperty.call(
            rightFlat,
            entry.key,
          );
          let expected: DiffKind;
          if (inLeft && !inRight) expected = 'removed';
          else if (!inLeft && inRight) expected = 'added';
          else if (deepEqual(leftFlat[entry.key], rightFlat[entry.key]))
            expected = 'unchanged';
          else expected = 'changed';
          expect(entry.kind).toBe(expected);

          // Values track presence: undefined exactly where the side lacks the key.
          expect(entry.left).toStrictEqual(
            inLeft ? leftFlat[entry.key] : undefined,
          );
          expect(entry.right).toStrictEqual(
            inRight ? rightFlat[entry.key] : undefined,
          );
        }
      }),
    );
  });

  // **Validates: Requirement 6.4**
  it('swapping the two runs swaps added<->removed and left<->right, keeping changed/unchanged', () => {
    fc.assert(
      fc.property(paramsObject, paramsObject, (leftObj, rightObj) => {
        const forward = diffRunParameters(
          runWithParams(leftObj),
          runWithParams(rightObj),
        );
        const swapped = diffRunParameters(
          runWithParams(rightObj),
          runWithParams(leftObj),
        );

        // Same key set (sorted union is order-independent of side).
        expect(swapped.entries.map((e) => e.key)).toEqual(
          forward.entries.map((e) => e.key),
        );

        const swappedByKey = new Map(swapped.entries.map((e) => [e.key, e]));
        for (const f of forward.entries) {
          const s = swappedByKey.get(f.key)!;
          const flipped: DiffKind =
            f.kind === 'added'
              ? 'removed'
              : f.kind === 'removed'
                ? 'added'
                : f.kind; // changed / unchanged preserved
          expect(s.kind).toBe(flipped);
          // left/right swap.
          expect(s.left).toStrictEqual(f.right);
          expect(s.right).toStrictEqual(f.left);
        }
      }),
    );
  });
});

describe('parseParameters / diffRunParameters — Property 13: parse errors surfaced (Req 6.5, 6.6, 10.1, 10.3)', () => {
  /**
   * A non-empty string that `parseParameters` cannot resolve to a plain object
   * (through up to two levels of JSON decoding), i.e. a genuine parse error.
   * Filtered against `parseParameters` itself so the arbitrary stays consistent
   * with the implementation's AWSJSON double-decode tolerance.
   */
  const nonJsonString: fc.Arbitrary<string> = fc
    .string({ minLength: 1 })
    .filter((s) => s.trim() !== '' && parseParameters(s) === null);

  // **Validates: Requirements 6.5, 10.1, 10.3**
  it('a non-empty non-JSON string makes that side a parse error (null from parseParameters)', () => {
    fc.assert(
      fc.property(nonJsonString, paramsObject, (bad, goodObj) => {
        expect(parseParameters(bad)).toBeNull();

        const goodJson = JSON.stringify(goodObj);
        const leftBad = diffRunParameters(
          makeRun({ parameters: bad }),
          makeRun({ parameters: goodJson }),
        );
        expect(leftBad.leftParseError).toBe(true);
        expect(leftBad.rightParseError).toBe(false);

        const rightBad = diffRunParameters(
          makeRun({ parameters: goodJson }),
          makeRun({ parameters: bad }),
        );
        expect(rightBad.leftParseError).toBe(false);
        expect(rightBad.rightParseError).toBe(true);
      }),
    );
  });

  // **Validates: Requirement 6.6**
  it('null/empty parameters are treated as an empty object with no parse error', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | null | undefined>(null, '', undefined),
        (empty) => {
          expect(parseParameters(empty)).toStrictEqual({});
          const result = diffRunParameters(
            makeRun({ parameters: empty }),
            makeRun({ parameters: empty }),
          );
          expect(result.leftParseError).toBe(false);
          expect(result.rightParseError).toBe(false);
          expect(result.entries).toEqual([]);
        },
      ),
    );
  });

  // **Validates: Requirements 6.5, 6.6**
  it('a valid-JSON side never flags a parse error', () => {
    fc.assert(
      fc.property(paramsObject, paramsObject, (a, b) => {
        const result = diffRunParameters(
          runWithParams(a),
          runWithParams(b),
        );
        expect(result.leftParseError).toBe(false);
        expect(result.rightParseError).toBe(false);
      }),
    );
  });

  // Regression: AppSync's AWSJSON scalar can deliver `parameters` double-encoded
  // (a JSON string whose decoded value is itself a JSON string). This previously
  // reported BOTH sides as parse errors when comparing two normal runs.
  it('parses double-encoded (AWSJSON) parameters without a parse error', () => {
    const obj = { input: 's3://bucket/x.csv', validate_params: false };
    const doubleEncoded = JSON.stringify(JSON.stringify(obj));
    expect(parseParameters(doubleEncoded)).toEqual(obj);
  });

  it('diffs two runs with double-encoded parameters cleanly (no parse errors)', () => {
    const left = { input: 's3://bucket/a.csv', validate_params: false };
    const right = { input: 's3://bucket/b.csv', validate_params: false };
    const result = diffRunParameters(
      makeRun({ workflowId: 'wf', parameters: JSON.stringify(JSON.stringify(left)) }),
      makeRun({ workflowId: 'wf', parameters: JSON.stringify(JSON.stringify(right)) }),
    );
    expect(result.leftParseError).toBe(false);
    expect(result.rightParseError).toBe(false);
    // The differing 'input' is detected; the shared flag is unchanged.
    const byKey = new Map(result.entries.map((e) => [e.key, e]));
    expect(byKey.get('input')?.kind).toBe('changed');
    expect(byKey.get('validate_params')?.kind).toBe('unchanged');
  });

  it('accepts an already-parsed object (AppSync decoded the AWSJSON)', () => {
    // Some clients receive parameters already decoded to an object.
    expect(
      parseParameters({ input: 's3://bucket/x.csv' } as unknown),
    ).toEqual({ input: 's3://bucket/x.csv' });
  });
});
