/**
 * logsExport — pure helpers for the LogsPanel download (QoL #4).
 *
 * These functions derive the download FILENAME and the exported FILE CONTENT
 * from exactly the log events currently loaded in the panel. They fabricate
 * nothing: {@link logContent} emits one line per input event and an empty
 * array yields an empty string, so the download can never contain a line that
 * was not in the loaded data.
 *
 * {@link formatTs} is the single source of truth for the on-screen line format;
 * LogsPanel imports it so the rendered <pre> and the downloaded text cannot
 * drift apart.
 */

/** Same sanitize rule as src/reports/ReportsView.tsx: unsafe chars -> '_'. */
const UNSAFE_FILENAME_CHARS = /[^a-z0-9.\-_]+/gi;

/**
 * Format an epoch-millisecond timestamp as the panel's on-screen prefix:
 * "YYYY-MM-DD HH:MM:SS.sss". A falsy/zero timestamp yields an empty string,
 * matching the panel's prior behavior.
 */
export function formatTs(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Build the download filename `${runId}-${taskId ?? stream}.log`, sanitized
 * with the same character rule used for the CSV export in ReportsView. For a
 * task stream the taskId identifies the file; otherwise the stream name does.
 */
export function logFilename(parts: {
  runId: string;
  taskId?: string;
  stream: string;
}): string {
  const suffix = parts.taskId ?? parts.stream;
  return `${parts.runId}-${suffix}.log`.replace(UNSAFE_FILENAME_CHARS, '_');
}

/**
 * Serialize the loaded events into the panel's exact on-screen format,
 * `${formatTs(timestamp)}  ${message}` per line, joined by '\n', preserving
 * input order. An empty array yields '' (no trailing newline). No line is
 * added that does not correspond to an input event.
 */
export function logContent(
  events: ReadonlyArray<{ timestamp: number; message: string }>,
): string {
  return events.map((e) => `${formatTs(e.timestamp)}  ${e.message}`).join('\n');
}
