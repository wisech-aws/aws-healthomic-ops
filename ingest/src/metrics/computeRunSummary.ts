/**
 * Pure per-run performance rollup (Run_Summary) computation
 * (workflow-performance-reports Req 1.3, 1.4, 10.2, 10.4; design §"Ingest
 * completion hook").
 *
 * `computeRunSummary` turns a terminal run's record, its tasks, and its measured
 * utilization series into a compact {@link RunSummaryRecord}. It is pure and
 * total — no I/O, never throws — so it is unit- and property-testable without
 * the pipeline.
 *
 * The load-bearing rule is availability honesty: any Tracked_Metric whose inputs
 * are absent is reported with its Availability_Flag `false` and its value left
 * `undefined` — NEVER a fabricated `0` — so aggregate statistics can exclude the
 * run rather than count it as zero (Req 10.2). Memory is converted to gibibytes
 * (GiB) from the measured byte series so the persisted value matches the rest of
 * the dashboard (Req 1.4, 10.4).
 */
import type { RunRecord, TaskRecord, RunSummaryRecord } from '../domain/records.js';
import { UNVERSIONED_LABEL } from '../domain/records.js';
import { RunStatus, TaskStatus } from '../domain/status.js';
import type { MetricSeries } from './parse.js';

/** Bytes in one gibibyte (binary), for the measured-memory conversion. */
const BYTES_PER_GIB = 1024 ** 3;
/** Milliseconds in one hour, to convert interval durations to CPU-hours. */
const MS_PER_HOUR = 3_600_000;

/** A task's execution interval `[start, end)` with its cpu weight. */
interface Interval {
  start: number;
  end: number;
  cpus: number | null;
}

/** Parse an ISO timestamp to epoch ms, or `null` when absent/unparseable. */
function parseMs(iso: string | undefined): number | null {
  if (iso == null) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build half-open execution intervals from tasks (mirrors the frontend's
 * `toIntervals` semantics): a task with no usable `startedAt` is dropped; a task
 * with no usable `stoppedAt` is treated as ending at `now`; inverted intervals
 * clamp `end = start`. `cpus` is carried through (`null` when absent).
 */
function toIntervals(tasks: readonly TaskRecord[], now: number): Interval[] {
  const intervals: Interval[] = [];
  for (const task of tasks) {
    const start = parseMs(task.startedAt);
    if (start == null) {
      continue;
    }
    const stop = parseMs(task.stoppedAt);
    const rawEnd = stop ?? now;
    const end = rawEnd < start ? start : rawEnd;
    intervals.push({ start, end, cpus: task.cpus ?? null });
  }
  return intervals;
}

/**
 * Peak count of simultaneously-active intervals via a boundary sweep. Ends are
 * processed before starts at an equal timestamp (half-open `[start, end)`), so
 * touching intervals are not counted as concurrent.
 */
function peakConcurrent(intervals: readonly Interval[]): number {
  if (intervals.length === 0) {
    return 0;
  }
  const events: { t: number; isEnd: boolean }[] = [];
  for (const i of intervals) {
    events.push({ t: i.start, isEnd: false });
    events.push({ t: i.end, isEnd: true });
  }
  events.sort((a, b) => (a.t !== b.t ? a.t - b.t : Number(b.isEnd) - Number(a.isEnd)));
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    if (e.isEnd) {
      cur -= 1;
    } else {
      cur += 1;
      if (cur > peak) {
        peak = cur;
      }
    }
  }
  return peak;
}

/** Mean of a numeric array, or `null` when empty. */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Max of a numeric array, or `null` when empty. */
function max(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((a, b) => (b > a ? b : a), values[0]);
}

/**
 * Collect all measured `usage` point values for a family across every series /
 * task in the run. Returns a flat list of the raw numeric values (converted by
 * the caller if needed). Non-usage roles (`limit`) are ignored so we summarize
 * actual consumption, not the ceiling.
 */
function usageValues(
  series: readonly MetricSeries[],
  family: 'CPU' | 'MEMORY',
): number[] {
  const values: number[] = [];
  for (const s of series) {
    if (s.family !== family || s.role !== 'usage') {
      continue;
    }
    for (const p of s.points) {
      if (Number.isFinite(p.value)) {
        values.push(p.value);
      }
    }
  }
  return values;
}

/**
 * Compute the per-run rollup for a terminal run.
 *
 * @param run    the run record (for status, timestamps, workflow labels).
 * @param tasks  the run's tasks (for duration inputs, CPU-hours, concurrency, counts).
 * @param series the run's measured utilization series (for mean/peak CPU & memory);
 *               empty when no measured metrics exist for the run.
 * @param now    the current instant (epoch ms), for still-open interval ends
 *               (a terminal run is normally fully stopped, but this keeps the
 *               function total and deterministic in tests).
 */
export function computeRunSummary(
  run: RunRecord,
  tasks: readonly TaskRecord[],
  series: readonly MetricSeries[],
  now: number,
): RunSummaryRecord {
  // ── Duration (wall-clock) ─────────────────────────────────────────────────
  const startMs = parseMs(run.startedAt);
  const stopMs = parseMs(run.stoppedAt);
  const durationMs =
    startMs != null && stopMs != null && stopMs >= startMs
      ? stopMs - startMs
      : undefined;

  // ── Task-derived metrics ──────────────────────────────────────────────────
  const intervals = toIntervals(tasks, now);
  const hasCpus = intervals.some((i) => i.cpus != null);

  const cpuHours = hasCpus
    ? intervals.reduce((sum, i) => {
        if (i.cpus == null) {
          return sum;
        }
        return sum + ((i.end - i.start) / MS_PER_HOUR) * i.cpus;
      }, 0)
    : undefined;

  const peakTasks = intervals.length > 0 ? peakConcurrent(intervals) : undefined;

  const taskCount = tasks.length;
  const failedTaskCount = tasks.filter(
    (t) => t.status === TaskStatus.FAILED || t.status === TaskStatus.CANCELLED,
  ).length;

  // ── Measured utilization (CPU vCPU; MEMORY bytes → GiB) ───────────────────
  const cpuVals = usageValues(series, 'CPU');
  const meanCpu = mean(cpuVals) ?? undefined;
  const peakCpu = max(cpuVals) ?? undefined;

  const memBytes = usageValues(series, 'MEMORY');
  const memGiB = memBytes.map((v) => v / BYTES_PER_GIB);
  const meanMemoryGiB = mean(memGiB) ?? undefined;
  const peakMemoryGiB = max(memGiB) ?? undefined;

  return {
    runId: run.runId,
    workflowName: run.workflowName,
    // Normalize an absent version to the shared Unversioned_Label so versionless
    // runs form their own consistent group (Req 1.2, 4.5).
    workflowVersionName: run.workflowVersionName ?? UNVERSIONED_LABEL,
    workflowId: run.workflowId,
    // A terminal run's status is one of COMPLETED/FAILED/CANCELLED; fall back to
    // the raw status when present (callers only invoke this at terminal state).
    status: (run.status as RunStatus) ?? RunStatus.COMPLETED,
    stoppedAt: run.stoppedAt,
    updatedAt: run.updatedAt,

    durationMs,
    durationAvailable: durationMs != null,
    meanCpu,
    peakCpu,
    cpuAvailable: cpuVals.length > 0,
    meanMemoryGiB,
    peakMemoryGiB,
    memoryAvailable: memBytes.length > 0,
    cpuHours,
    cpuHoursAvailable: cpuHours != null,
    peakConcurrentTasks: peakTasks,
    concurrencyAvailable: peakTasks != null,
    taskCount,
    failedTaskCount,
  };
}
