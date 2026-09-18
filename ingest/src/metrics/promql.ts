/**
 * PromQL selector construction for HealthOmics utilization metrics.
 *
 * VERIFIED constraint: CloudWatch's Prometheus-compatible query API rejects a bare dotted
 * metric name (e.g. `aws.omics.task.cpu.usage`) as a selector — PromQL identifiers cannot
 * contain `.`, so the parser fails on it. The metric must instead be referenced through the
 * special `__name__` label matcher (e.g. `{__name__="aws.omics.task.cpu.usage"}`), which
 * accepts any string value regardless of characters. This is a parser requirement of the
 * query language, not a style preference.
 */

/**
 * Build a well-formed PromQL selector referencing a dotted metric via `__name__`, always
 * scoped to a single run id.
 *
 * The metric name is referenced only through the `__name__` matcher (never as a bare
 * identifier — see module doc for why) and the `@resource.aws.omics.run.id` matcher is
 * always present, scoping the query to exactly one run. Pure and total: any string for
 * `metricName` or `runId` — including strings containing quotes, backslashes, spaces, or
 * other special characters — produces a syntactically well-formed, parseable selector.
 *
 * @example
 * buildSelector('aws.omics.task.cpu.usage', 'abc123')
 * // => '{__name__="aws.omics.task.cpu.usage", "@resource.aws.omics.run.id"="abc123"}'
 */
export function buildSelector(metricName: string, runId: string): string {
  return `{__name__=${q(metricName)}, "@resource.aws.omics.run.id"=${q(runId)}}`;
}

/**
 * Double-quote and escape a PromQL label-matcher value.
 *
 * Escapes `\` first (so it doesn't double-escape the `"` escapes it introduces) and then `"`,
 * so that any input value is safely embedded in a quoted PromQL string without letting the
 * value's own quotes or backslashes break out of the string literal.
 */
function q(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
