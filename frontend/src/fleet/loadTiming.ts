/**
 * Browser load-time instrumentation for the fleet view (User Timing API).
 *
 * Each fleet load gets a timer that records:
 *   - marks `fleet:start:<seq>`, `fleet:first-rows:<seq>` and
 *     `fleet:complete:<seq>` (per-load names, so loads never collide; cleared
 *     once the load finishes so the mark buffer stays bounded), and
 *   - measures `fleet:first-rows` and `fleet:complete` (fixed names, so
 *     DevTools Performance groups them), with `{ kind, seq, pages, runs }`
 *     as `detail`.
 * When a load finishes it logs ONE concise `console.info` line, e.g.
 *   `[fleet] cold load: first rows 212 ms, complete 1,140 ms, 6 pages, 513 runs`
 * and appends a record to a ring buffer of the last {@link MAX_RECORDS} loads,
 * exposed read-only as `window.__fleetLoadTimings` for copy/paste.
 *
 * No network or analytics calls, and no PII: records hold counts and
 * durations only (never run names or ids). Every browser API call is guarded
 * so a missing or throwing `performance`/`console` (jsdom, old browsers) can
 * never break a load. Pure module: no React, so it cannot cause renders.
 */

/** What triggered a fleet load. */
export type FleetLoadKind = 'cold' | 'warm' | 'refresh' | 'reconnect';

/** How a load ended. */
export type FleetLoadOutcome = 'complete' | 'error' | 'superseded';

export interface FleetLoadTimingRecord {
  readonly seq: number;
  readonly kind: FleetLoadKind;
  readonly outcome: FleetLoadOutcome;
  /** Wall-clock ISO start, for copy/paste context. */
  readonly startedAt: string;
  /** Rows (cached or from a previous load) were already on screen. */
  readonly rowsShownAtStart: boolean;
  /** Start -> first rows rendered; null when rows were already shown or none arrived. */
  readonly firstRowsMs: number | null;
  /** Start -> complete / error / superseded. */
  readonly completeMs: number;
  readonly pages: number;
  readonly runs: number;
  readonly capped: boolean;
  /** 1-based page that failed (outcome 'error'). */
  readonly failedPage?: number;
}

export interface FleetLoadFinish {
  readonly outcome: FleetLoadOutcome;
  readonly pages: number;
  readonly runs: number;
  readonly capped?: boolean;
  readonly failedPage?: number;
}

export interface FleetLoadTimer {
  readonly seq: number;
  /** Marks the first rows of this load as rendered. Idempotent; no-op after finish. */
  markFirstRows(): void;
  /** Ends the timer: marks, measures, logs one line, records. Idempotent. */
  finish(result: FleetLoadFinish): void;
}

/** Number of timing records kept on `window.__fleetLoadTimings`. */
export const MAX_RECORDS = 20;

const records: FleetLoadTimingRecord[] = [];
let nextSeq = 1;
let windowPropertyInstalled = false;

/** Runs `fn`, swallowing anything it throws (instrumentation must not throw). */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** The global `performance` object if it exists, else undefined. */
function perf(): Performance | undefined {
  return safe(() =>
    typeof performance === 'undefined' || performance == null
      ? undefined
      : performance,
  );
}

/** High-resolution now when available, else wall clock. */
function nowMs(): number {
  const p = perf();
  const t = safe(() => (typeof p?.now === 'function' ? p.now() : undefined));
  return typeof t === 'number' ? t : Date.now();
}

function mark(name: string): void {
  const p = perf();
  if (typeof p?.mark === 'function') {
    safe(() => p.mark(name));
  }
}

function measure(
  name: string,
  startMark: string,
  endMark: string,
  detail: Record<string, unknown>,
): void {
  const p = perf();
  if (typeof p?.measure !== 'function') {
    return;
  }
  const done = safe(() => {
    p.measure(name, { start: startMark, end: endMark, detail });
    return true;
  });
  if (done !== true) {
    // Older engines only support the (name, startMark, endMark) form.
    safe(() => p.measure(name, startMark, endMark));
  }
}

function clearMarks(names: readonly string[]): void {
  const p = perf();
  if (typeof p?.clearMarks !== 'function') {
    return;
  }
  for (const name of names) {
    safe(() => p.clearMarks(name));
  }
}

const KIND_LABEL: Record<FleetLoadKind, string> = {
  cold: 'cold load',
  warm: 'warm revalidate',
  refresh: 'refresh',
  reconnect: 'reconnect',
};

function fmtMs(ms: number): string {
  return `${Math.round(ms).toLocaleString('en-US')} ms`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** The one-line console summary for a load record (pure). */
export function formatFleetLoadLine(r: FleetLoadTimingRecord): string {
  const counts = `${plural(r.pages, 'page')}, ${plural(r.runs, 'run')}${
    r.capped ? ' (capped)' : ''
  }`;
  let body: string;
  if (r.outcome === 'error') {
    body = `failed on page ${r.failedPage ?? r.pages + 1} after ${fmtMs(r.completeMs)}`;
  } else if (r.outcome === 'superseded') {
    body = `superseded after ${fmtMs(r.completeMs)}`;
  } else if (r.rowsShownAtStart) {
    body =
      r.kind === 'warm'
        ? `cached rows shown instantly, revalidate complete ${fmtMs(r.completeMs)}`
        : `rows kept, complete ${fmtMs(r.completeMs)}`;
  } else if (r.firstRowsMs != null) {
    body = `first rows ${fmtMs(r.firstRowsMs)}, complete ${fmtMs(r.completeMs)}`;
  } else {
    body = `no rows, complete ${fmtMs(r.completeMs)}`;
  }
  return `[fleet] ${KIND_LABEL[r.kind]}: ${body}, ${counts}`;
}

/** Frozen copies of the last {@link MAX_RECORDS} records, oldest first. */
export function getFleetLoadTimings(): readonly FleetLoadTimingRecord[] {
  return Object.freeze(records.map((r) => Object.freeze({ ...r })));
}

/** Test-only: forget all records and restart sequence numbers. */
export function resetFleetLoadTimingsForTests(): void {
  records.length = 0;
  nextSeq = 1;
}

/** Installs the read-only `window.__fleetLoadTimings` getter (once). */
function installWindowProperty(): void {
  if (windowPropertyInstalled || typeof window === 'undefined') {
    return;
  }
  safe(() => {
    Object.defineProperty(window, '__fleetLoadTimings', {
      configurable: true,
      enumerable: false,
      get: getFleetLoadTimings,
    });
    windowPropertyInstalled = true;
  });
}

function record(r: FleetLoadTimingRecord): void {
  records.push(r);
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
  installWindowProperty();
}

/** Starts timing one fleet load (marks `fleet:start:<seq>`). Never throws. */
export function startFleetLoadTimer(
  kind: FleetLoadKind,
  opts: { readonly rowsShownAtStart: boolean },
): FleetLoadTimer {
  const seq = nextSeq++;
  const startMark = `fleet:start:${seq}`;
  const firstMark = `fleet:first-rows:${seq}`;
  const completeMark = `fleet:complete:${seq}`;
  const startedAt = new Date().toISOString();
  const t0 = nowMs();
  let firstRowsMs: number | null = null;
  let finished = false;
  mark(startMark);

  return {
    seq,
    markFirstRows() {
      if (finished || firstRowsMs !== null) {
        return;
      }
      firstRowsMs = nowMs() - t0;
      mark(firstMark);
    },
    finish({ outcome, pages, runs, capped = false, failedPage }) {
      if (finished) {
        return;
      }
      finished = true;
      const completeMs = nowMs() - t0;
      mark(completeMark);
      const detail = { kind, seq, pages, runs };
      if (firstRowsMs !== null) {
        measure('fleet:first-rows', startMark, firstMark, detail);
      }
      measure('fleet:complete', startMark, completeMark, { ...detail, outcome });
      clearMarks([startMark, firstMark, completeMark]);
      const r: FleetLoadTimingRecord = {
        seq,
        kind,
        outcome,
        startedAt,
        rowsShownAtStart: opts.rowsShownAtStart,
        firstRowsMs,
        completeMs,
        pages,
        runs,
        capped,
        ...(failedPage !== undefined ? { failedPage } : {}),
      };
      safe(() => record(r));
      safe(() => console.info(formatFleetLoadLine(r)));
    },
  };
}
