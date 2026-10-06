/**
 * QoL #3 — Pure URL hash parse/serialize for deep-linkable views.
 *
 * This module is the PURE core of the deep-linking feature: it maps between a
 * {@link ViewState} and the single location-hash scheme the app understands,
 * with NO React, DOM, or History-API imports. All window/history wiring lives
 * in the separate `useDeepLink` hook. Keeping the logic here makes it trivially
 * unit- and property-testable (see viewHash.test.ts) and reusable.
 *
 * The ONE scheme:
 *   - fleet view     ->  '#/'
 *   - a run          ->  '#/run/<runId>'
 *   - a run + task   ->  '#/run/<runId>/task/<taskId>'
 *
 * Id segments are URL-encoded on serialize and decoded on parse so ids
 * containing reserved characters ('/', '#', '%', spaces, …) round-trip safely.
 *
 * NO-FABRICATION CONTRACT (strict): {@link parseViewHash} MUST NEVER throw and
 * MUST NEVER invent a run or task. Any input that does not match the scheme —
 * '', '#', '#/', unknown paths, '#/run/' with an empty id — resolves to the
 * fleet view. A run hash with a missing/empty task id resolves to the run with
 * no task selected. The hook/UI layer is then responsible for verifying that a
 * parsed run/task actually exists before showing it.
 */

/** The app's navigable view, independent of any router or DOM. */
export type ViewState =
  | { kind: 'fleet' }
  | { kind: 'run'; runId: string; taskId?: string };

/** The canonical fleet state, reused so callers can compare by value. */
const FLEET: ViewState = { kind: 'fleet' };

/**
 * Decode a single URL-encoded id segment. `decodeURIComponent` throws on a
 * malformed escape sequence (e.g. a lone '%'); the no-fabrication contract
 * requires we never throw, so a malformed segment is treated as absent (null)
 * and the caller falls back to fleet / run-with-no-task.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Parse a location hash (e.g. `window.location.hash`) into a {@link ViewState}.
 *
 * Recognizes only '#/run/<runId>' and '#/run/<runId>/task/<taskId>'. Everything
 * else — including the empty string, '#', '#/', unknown paths, and a '#/run/'
 * with an empty run id — maps to the fleet view. Never throws, never fabricates
 * a run/task; an empty/malformed task id yields the run with no task selected.
 */
export function parseViewHash(hash: string): ViewState {
  if (typeof hash !== 'string' || hash.length === 0) {
    return FLEET;
  }

  // Normalize the leading '#'. '#' and '#/' alone are the fleet view.
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  // Strip a single leading '/', so both '#/run/..' and '#run/..' are accepted.
  const path = withoutHash.startsWith('/') ? withoutHash.slice(1) : withoutHash;
  if (path.length === 0) {
    return FLEET;
  }

  const segments = path.split('/');
  // The only recognized path starts with the literal 'run'.
  if (segments[0] !== 'run') {
    return FLEET;
  }

  const encodedRunId = segments[1] ?? '';
  if (encodedRunId.length === 0) {
    // '#/run' or '#/run/' with no id -> fleet (never a fabricated run).
    return FLEET;
  }
  const runId = decodeSegment(encodedRunId);
  if (runId == null || runId.length === 0) {
    return FLEET;
  }

  // Optional '/task/<taskId>' suffix. Any other trailing shape ignores the
  // task portion and resolves to the run with no task selected.
  if (segments[2] === 'task') {
    const encodedTaskId = segments[3] ?? '';
    if (encodedTaskId.length > 0) {
      const taskId = decodeSegment(encodedTaskId);
      if (taskId != null && taskId.length > 0) {
        return { kind: 'run', runId, taskId };
      }
    }
    // '#/run/<id>/task' or '#/run/<id>/task/' with empty/malformed id ->
    // run with no task selected (no fabrication).
    return { kind: 'run', runId };
  }

  return { kind: 'run', runId };
}

/**
 * Serialize a {@link ViewState} into the canonical location hash. Produces
 * '#/' for fleet, '#/run/<encoded>' for a run, and
 * '#/run/<encoded>/task/<encoded>' for a run+task. Id segments are
 * URL-encoded so they round-trip through {@link parseViewHash}.
 */
export function serializeViewHash(state: ViewState): string {
  if (state.kind === 'fleet') {
    return '#/';
  }
  const base = `#/run/${encodeURIComponent(state.runId)}`;
  if (state.taskId != null && state.taskId.length > 0) {
    return `${base}/task/${encodeURIComponent(state.taskId)}`;
  }
  return base;
}
