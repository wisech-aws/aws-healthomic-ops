/**
 * Parameters diff between two runs (enhancement 6).
 *
 * A run's `parameters` is an AWSJSON string. This module parses each run's
 * parameters into an object, flattens nested objects into dotted-path keys, and
 * classifies each key in the union of the two runs as added / removed / changed
 * / unchanged. It is a pure helper so the diff rules can be unit- and
 * property-tested independently of the React view.
 *
 * The JSON-parse-with-fallback here mirrors the inline logic in
 * `RunDetailView`'s `RunInputsOutputs`, with the important distinction that a
 * present-but-unparseable string is reported as a parse error (via a `null`
 * return) so the diff can surface a per-side notice, whereas a null/empty
 * string is treated as an empty parameter object with no error.
 */
import type { Run } from '../api/types';

/** How a single flattened parameter key changed between two runs. */
export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** One flattened parameter key and how it differs between the two runs. */
export interface ParamDiffEntry {
  /** Dotted path for nested keys, e.g. "ref.fasta". */
  readonly key: string;
  readonly kind: DiffKind;
  /** Value in the left run (undefined when the key is `added`). */
  readonly left: unknown;
  /** Value in the right run (undefined when the key is `removed`). */
  readonly right: unknown;
}

/** Full diff of two runs' parameters. */
export interface ParamsDiffResult {
  /** One entry per key in the union of both runs, sorted by key. */
  readonly entries: ParamDiffEntry[];
  /** The left run's `parameters` was a non-empty, non-JSON string. */
  readonly leftParseError: boolean;
  /** The right run's `parameters` was a non-empty, non-JSON string. */
  readonly rightParseError: boolean;
  /** Both runs share the same non-null `workflowId`. */
  readonly sameWorkflow: boolean;
}

/**
 * Parses a run's `parameters` into an object, tolerant of how AppSync's
 * `AWSJSON` scalar may deliver it.
 *
 * A run's `parameters` is stored as a JSON string in DynamoDB; over the wire an
 * `AWSJSON` field can arrive as (a) an already-parsed object, (b) a single
 * JSON-encoded string, or (c) a DOUBLE-encoded string (a JSON string whose
 * decoded value is itself a JSON string). An earlier single-parse version
 * reported (c) as a parse error, which is why comparing two normal runs showed
 * "parameters could not be parsed" on both sides. This unwraps up to two levels
 * of string encoding, mirroring `rundetail/parseRunParameters`.
 *
 * Contract preserved for the diff's error flags:
 *  - null / empty  -> `{}` (empty parameter object, NO parse error);
 *  - a value that resolves to a plain object -> that object;
 *  - anything else (non-object JSON, or unparseable) -> `null` (parse error).
 */
export function parseParameters(
  parameters: unknown,
): Record<string, unknown> | null {
  if (parameters == null || parameters === '') {
    return {};
  }
  // Already an object (AppSync decoded the AWSJSON for us).
  if (isPlainObject(parameters)) {
    return parameters;
  }
  if (typeof parameters !== 'string') {
    return null;
  }
  let value: unknown = parameters;
  // Unwrap up to two levels of JSON-string encoding.
  for (let i = 0; i < 2 && typeof value === 'string'; i += 1) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return isPlainObject(value) ? value : null;
}

/**
 * Diffs two runs' parameters (Req 6.1–6.7).
 *
 * Nested objects are flattened to dotted paths so the diff is a flat, sortable
 * key list. Each key in the union of both flattened objects yields exactly one
 * entry, classified by deep-equality of its values. Runs of different workflows
 * are still diffed but flagged `sameWorkflow: false` so the view can warn.
 *
 * A per-side parse error (present but non-JSON `parameters`) is reported via the
 * corresponding `leftParseError` / `rightParseError` flag; that side is then
 * treated as having no parameters for diff purposes.
 */
export function diffRunParameters(left: Run, right: Run): ParamsDiffResult {
  const leftParsed = parseParameters(left.parameters);
  const rightParsed = parseParameters(right.parameters);
  const leftParseError = leftParsed === null;
  const rightParseError = rightParsed === null;

  const leftFlat = flatten(leftParsed ?? {});
  const rightFlat = flatten(rightParsed ?? {});

  const keys = Array.from(
    new Set([...Object.keys(leftFlat), ...Object.keys(rightFlat)]),
  ).sort();

  const entries: ParamDiffEntry[] = keys.map((key) => {
    const inLeft = Object.prototype.hasOwnProperty.call(leftFlat, key);
    const inRight = Object.prototype.hasOwnProperty.call(rightFlat, key);
    const leftValue = leftFlat[key];
    const rightValue = rightFlat[key];

    let kind: DiffKind;
    if (inLeft && !inRight) {
      kind = 'removed';
    } else if (!inLeft && inRight) {
      kind = 'added';
    } else if (deepEqual(leftValue, rightValue)) {
      kind = 'unchanged';
    } else {
      kind = 'changed';
    }

    return {
      key,
      kind,
      left: inLeft ? leftValue : undefined,
      right: inRight ? rightValue : undefined,
    };
  });

  const sameWorkflow =
    left.workflowId != null &&
    right.workflowId != null &&
    left.workflowId === right.workflowId;

  return { entries, leftParseError, rightParseError, sameWorkflow };
}

/** Narrows an unknown value to a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flattens a nested object into a single-level map keyed by dotted paths.
 *
 * Nested plain objects are recursed into (`{ a: { b: 1 } }` → `{ "a.b": 1 }`);
 * arrays and primitive values are treated as leaf values and kept whole. An
 * empty nested object contributes no keys, which is the intended behavior for a
 * diff over leaf parameters.
 */
function flatten(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) {
      Object.assign(result, flatten(value, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

/**
 * Structural deep-equality for JSON-shaped values (the leaf values produced by
 * {@link flatten}: primitives and arrays, since nested objects are flattened
 * away before comparison). Implemented locally to avoid adding a dependency.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual(a[key], b[key]),
    );
  }
  return false;
}
