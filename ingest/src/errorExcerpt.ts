/**
 * Best-effort extraction of the most relevant error excerpt from a raw log
 * tail (Option B: HealthOmics' own `statusMessage` is often just "go read the
 * CloudWatch logs" boilerplate — see e.g. "Workflow run failed. Review the
 * CloudWatch logs engine log stream: ... to debug the failure." — with no
 * actual diagnosis. This module locates the actual error line(s) so the
 * dashboard can show them inline instead of making every failure a manual
 * CloudWatch dig).
 *
 * Pure and total: given the same lines, always returns the same result; never
 * throws; never fabricates a result when no error-shaped line exists (Req: no
 * fabrication — {@link ExcerptResult.found} is `false` and `lines` is empty in
 * that case, not a guessed value).
 *
 * Strategy (validated against two real production failures — an engine-level
 * Nextflow `SchemaValidationException` with a trailing Java stack trace, and a
 * task-level plain `[ERROR] ...` pair with no stack trace at all):
 *
 *   1. If the log ends in a run of stack-frame lines (`  at ...`), walk
 *      backward from just before that run to the nearest line that reads like
 *      a genuine exception/error HEADLINE — a fully-qualified exception class
 *      name followed by a colon (e.g. `foo.bar.SomeException: ...`), or a
 *      bracketed `[ERROR]` marker. This deliberately excludes any line that
 *      merely contains the word "error" as prose (e.g. "Error for field..."),
 *      which would otherwise anchor on the wrong line (validated against the
 *      real rnaseq failure, whose actual headline is 11 lines before the line
 *      that superficially looks the most "error-shaped").
 *   2. Return the headline through (but excluding) the stack-frame run,
 *      capped to `maxLines` (truncated from the END — the headline and
 *      earliest detail lines are the most informative part).
 *   3. If there is no trailing stack trace (or no headline line precedes it),
 *      fall back to the last contiguous run of lines matching a generic
 *      error/exception/fail/traceback pattern (validated against the
 *      fetchngs task failure, which has no stack trace at all).
 *   4. If nothing matches either heuristic, return `found: false` — never a
 *      fabricated excerpt.
 */

/** A trailing Java/Groovy-style stack-frame line, e.g. `  at foo.Bar.baz(Bar.java:1)`. */
const STACK_FRAME_RE = /^\s*at\s/;

/**
 * A genuine exception/error HEADLINE: a (possibly fully-qualified) identifier
 * ending in "Exception" or "Error" immediately followed by a colon (the
 * conventional `Throwable#toString()` shape across Java/Groovy/Python
 * tracebacks), or a bracketed `[ERROR]` marker. Deliberately narrower than a
 * bare "error"/"exception" substring match, which would also match prose like
 * "Error for field 'fastq_1'..." — a real detail line, not the headline.
 */
const HEADLINE_RE = /\b[\w.]*(?:Exception|Error)\s*:|^\s*\[ERROR\]/i;

/** A generic error-shaped line, used only when no stack-trace headline is found. */
const GENERIC_ERROR_RE = /error|exception|fail|traceback/i;

/** Default cap on the number of lines returned in an excerpt. */
export const DEFAULT_MAX_EXCERPT_LINES = 15;

/** Result of {@link extractErrorExcerpt}. */
export interface ExcerptResult {
  /**
   * Whether an error-shaped excerpt was located. `false` means `lines` is
   * empty — never a fabricated guess.
   */
  found: boolean;
  /** The extracted lines, in original log order. Empty when `found` is `false`. */
  lines: string[];
  /**
   * Whether the located excerpt exceeded `maxLines` and was cut down. Lets the
   * caller/UI disclose that the shown excerpt is a partial view.
   */
  truncated: boolean;
}

const NOT_FOUND: ExcerptResult = { found: false, lines: [], truncated: false };

/**
 * Extract the most relevant error excerpt from a sequence of raw log lines
 * (oldest-first, matching CloudWatch's `GetLogEvents` message order). See the
 * module doc for the extraction strategy. Pure, total, never throws.
 */
export function extractErrorExcerpt(
  lines: readonly string[],
  maxLines: number = DEFAULT_MAX_EXCERPT_LINES,
): ExcerptResult {
  const nonEmpty = lines.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) {
    return NOT_FOUND;
  }

  // 1. Find where a trailing run of stack-frame lines begins, if any.
  let i = nonEmpty.length - 1;
  while (i >= 0 && STACK_FRAME_RE.test(nonEmpty[i])) {
    i -= 1;
  }
  const stackBlockStart = i + 1;

  if (stackBlockStart < nonEmpty.length) {
    // A trailing stack trace exists. Walk backward for the real headline.
    let j = stackBlockStart - 1;
    while (j >= 0 && !HEADLINE_RE.test(nonEmpty[j])) {
      j -= 1;
    }
    if (j >= 0) {
      const block = nonEmpty.slice(j, stackBlockStart);
      const truncated = block.length > maxLines;
      return { found: true, lines: truncated ? block.slice(0, maxLines) : block, truncated };
    }
  }

  // 2. No usable stack-trace headline: fall back to the last contiguous run
  // of generic error-shaped lines.
  let k = nonEmpty.length - 1;
  while (k >= 0 && !GENERIC_ERROR_RE.test(nonEmpty[k])) {
    k -= 1;
  }
  if (k < 0) {
    return NOT_FOUND;
  }
  let start = k;
  while (start - 1 >= 0 && GENERIC_ERROR_RE.test(nonEmpty[start - 1])) {
    start -= 1;
  }
  const block = nonEmpty.slice(start, k + 1);
  const truncated = block.length > maxLines;
  return { found: true, lines: truncated ? block.slice(-maxLines) : block, truncated };
}
