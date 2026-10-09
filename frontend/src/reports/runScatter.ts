/**
 * Pure data transform for the per-run duration scatter in the Reports view.
 *
 * Strict no-fabrication: a run is plotted only when it carries a usable
 * `durationMs` (a finite number >= 0) AND a parseable `stoppedAt`. Runs that
 * fail either test are OMITTED — never emitted as a fabricated 0 — so a missing
 * value can never masquerade as an on-time run near the origin.
 */
import type { RunPoint, RunStatus } from '../api/types';

/** One plottable run point: x = stop time epoch ms, y = duration in MINUTES. */
export interface ScatterDatum {
  readonly runId: string;
  /** `stoppedAt` as epoch milliseconds (parseable by construction). */
  readonly x: number;
  /** Duration in minutes (`durationMs / 60000`). */
  readonly y: number;
  readonly status?: RunStatus | null;
}

/** True when `v` is a finite number >= 0 (rejects null/undefined/NaN/Infinity/negative). */
function isUsableDurationMs(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Map the paged run points to plottable scatter data, keeping only runs with a
 * usable `durationMs` and a parseable `stoppedAt`. Input order is preserved.
 */
export function runPointsToScatterData(points: readonly RunPoint[]): ScatterDatum[] {
  const out: ScatterDatum[] = [];
  for (const p of points) {
    if (!isUsableDurationMs(p.durationMs)) {
      continue;
    }
    const x = Date.parse(p.stoppedAt);
    if (Number.isNaN(x)) {
      continue;
    }
    out.push({ runId: p.runId, x, y: p.durationMs / 60000, status: p.status });
  }
  return out;
}

/**
 * Format a duration in milliseconds as `H:MM:SS`. Mirrors the existing
 * `fmtStat` duration branch in ReportsView so the scatter tooltip and the
 * aggregate table share one source of truth.
 */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
