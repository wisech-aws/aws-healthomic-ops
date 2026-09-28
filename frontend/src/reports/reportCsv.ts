/**
 * Pure CSV serialization for a workflow/version performance report
 * (workflow-performance-reports Req 7.x, 10.2, 10.4).
 *
 * Produces two sections in one CSV text:
 *   1. an AGGREGATE block — one row per tracked metric with mean/median/p90 and
 *      the "N of M" availability denominator, and
 *   2. a PER-RUN block — one row per run with its tracked-metric values.
 *
 * Availability honesty is preserved: an unavailable metric renders as an EMPTY
 * cell (never `0`), and memory columns are labeled GiB. The function is pure and
 * total so it is unit-testable and produces identical output to what the view
 * shows.
 */
import type { WorkflowReport, RunPoint } from '../api/types';

/** Escape a CSV field per RFC 4180: quote when it contains `,`, `"`, or a newline. */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Render a nullable number as a CSV cell: empty string when null/undefined (never 0). */
function num(value: number | null | undefined): string {
  return value == null ? '' : String(value);
}

/** Join one CSV row from already-escaped-or-numeric fields. */
function row(fields: readonly string[]): string {
  return fields.join(',');
}

/**
 * Serialize a {@link WorkflowReport} plus its per-run `rows` to CSV text
 * (analytics export). The aggregate block comes from the size-bounded report;
 * the per-run `rows` are fetched separately via the paginated
 * `listWorkflowRunPoints` path so the export scales to High_Volume without
 * bloating the report payload (Req 7.2, 11.3). An unavailable metric value is
 * an empty cell, never a fabricated `0` (Req 7.3, 10.2).
 */
export function toReportCsv(
  report: WorkflowReport,
  rows: readonly RunPoint[],
): string {
  const lines: string[] = [];

  // Header / provenance.
  lines.push(row(['Workflow', csvEscape(report.workflowName)]));
  lines.push(row(['Version', csvEscape(report.versionName)]));
  lines.push(row(['Window start', csvEscape(report.window.start)]));
  lines.push(row(['Window end', csvEscape(report.window.end)]));
  lines.push(row(['Total runs', String(report.runCount)]));
  lines.push(row(['Completed', String(report.succeeded)]));
  lines.push(row(['Failed', String(report.failed)]));
  lines.push(row(['Cancelled', String(report.cancelled)]));
  lines.push(row(['Name collision', report.collision ? 'YES' : 'no']));
  lines.push('');

  // Aggregate block.
  lines.push('Aggregate metrics');
  lines.push(row(['metric', 'unit', 'mean', 'median', 'p90', 'availableRuns', 'totalRuns']));
  for (const m of report.metrics) {
    lines.push(
      row([
        csvEscape(m.key),
        csvEscape(m.unit ?? ''),
        num(m.mean),
        num(m.median),
        num(m.p90),
        String(m.availableCount),
        String(m.totalCount),
      ]),
    );
  }
  lines.push('');

  // Per-run block.
  lines.push('Per-run values');
  lines.push(
    row([
      'runId',
      'stoppedAt',
      'status',
      'durationMs',
      'meanCpu(vCPU)',
      'peakCpu(vCPU)',
      'meanMemory(GiB)',
      'peakMemory(GiB)',
      'cpuHours',
      'peakConcurrentTasks',
      'taskCount',
      'failedTaskCount',
    ]),
  );
  for (const p of rows) {
    lines.push(
      row([
        csvEscape(p.runId),
        csvEscape(p.stoppedAt),
        csvEscape(p.status ?? ''),
        num(p.durationMs),
        num(p.meanCpu),
        num(p.peakCpu),
        num(p.meanMemoryGiB),
        num(p.peakMemoryGiB),
        num(p.cpuHours),
        num(p.peakConcurrentTasks),
        num(p.taskCount),
        num(p.failedTaskCount),
      ]),
    );
  }

  return lines.join('\n') + '\n';
}
