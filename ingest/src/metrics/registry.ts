/**
 * Metric registry — the pure `aws.omics.*` metric table.
 *
 * This module is the single source of truth for which CloudWatch OTel metric
 * names exist per {@link MetricFamily}, and whether each metric is an `usage`
 * (actual) or `limit` (ceiling) measurement (Req 2.1, 3.1, 9.1, 9.2, 9.3, 9.5,
 * 9.7). It mirrors the design's §5 "Metric registry" table exactly and
 * contains no I/O: `metricsHandler.ts` uses {@link resolveSelectors} to expand
 * a caller-requested family list into the concrete metrics to query, then
 * builds/signs/POSTs one `query_range` per selector (`promql.ts`,
 * `signedQuery.ts`) and tags each parsed series with its `family`/`role`
 * (`parse.ts`).
 *
 * NETWORK and FILESYSTEM have no `limit` metric in CloudWatch: their usage
 * series are split by the `network.io.direction` / `filesystem.io.direction`
 * labels, which is the parser's job (`parse.ts`), not this registry's.
 *
 * Default family selection: {@link resolveSelectors} treats an empty or
 * `undefined` `families` argument as {@link CORE_FAMILIES} (CPU + MEMORY), so
 * callers may either pass `families` through unchanged (including
 * empty/undefined) or pass `CORE_FAMILIES` explicitly — both produce the same
 * result.
 */

/**
 * The resource-utilization metric families this feature surfaces.
 *
 * A definition whose family is not one of these has no registry entry and is
 * unsupported (Req 2, 3, 9).
 */
export type MetricFamily =
  | 'CPU'
  | 'MEMORY'
  | 'NETWORK'
  | 'FILESYSTEM'
  | 'SCRATCH'
  | 'GPU'
  | 'RUN_FILESYSTEM';

/** Whether a metric measures the actual (`usage`) value or its ceiling (`limit`). */
export type MetricRole = 'usage' | 'limit';

/** One metric name + role entry within a family's registry row. */
export interface RegistryEntry {
  metricName: string;
  role: MetricRole;
}

/**
 * The default family set queried when a caller does not request specific
 * families: CPU + memory (Req 2.1, 3.1, 8 "bound cost by default").
 */
export const CORE_FAMILIES: MetricFamily[] = ['CPU', 'MEMORY'];

/**
 * The pure metric table, keyed by {@link MetricFamily}, matching design §5
 * exactly:
 *
 * | Family | usage metric(s) | limit metric | Req |
 * |---|---|---|---|
 * | CPU | `aws.omics.task.cpu.usage` | `aws.omics.task.cpu.limit` | 2.1 |
 * | MEMORY | `aws.omics.task.memory.usage` | `aws.omics.task.memory.limit` | 3.1 |
 * | NETWORK | `aws.omics.task.network.io` | — | 9.1 |
 * | FILESYSTEM | `aws.omics.task.filesystem.io`, `aws.omics.task.filesystem.operations` | — | 9.2 |
 * | SCRATCH | `aws.omics.task.filesystem.scratch.storage.usage` | `aws.omics.task.filesystem.scratch.storage.limit` | 9.3 |
 * | GPU | `aws.omics.task.gpu.utilization`, `aws.omics.task.gpu.memory.usage` | `aws.omics.task.gpu.memory.limit` | 9.5 |
 * | RUN_FILESYSTEM | `aws.omics.run.filesystem.usage` | `aws.omics.run.filesystem.limit` | 9.7 |
 */
export const REGISTRY: Record<MetricFamily, RegistryEntry[]> = {
  CPU: [
    { metricName: 'aws.omics.task.cpu.usage', role: 'usage' },
    { metricName: 'aws.omics.task.cpu.limit', role: 'limit' },
  ],
  MEMORY: [
    { metricName: 'aws.omics.task.memory.usage', role: 'usage' },
    { metricName: 'aws.omics.task.memory.limit', role: 'limit' },
  ],
  NETWORK: [
    // Split by `network.io.direction` (parser's responsibility); no limit metric.
    { metricName: 'aws.omics.task.network.io', role: 'usage' },
  ],
  FILESYSTEM: [
    // Split by `filesystem.io.direction` (parser's responsibility); no limit metric.
    { metricName: 'aws.omics.task.filesystem.io', role: 'usage' },
    { metricName: 'aws.omics.task.filesystem.operations', role: 'usage' },
  ],
  SCRATCH: [
    { metricName: 'aws.omics.task.filesystem.scratch.storage.usage', role: 'usage' },
    { metricName: 'aws.omics.task.filesystem.scratch.storage.limit', role: 'limit' },
  ],
  GPU: [
    { metricName: 'aws.omics.task.gpu.utilization', role: 'usage' },
    { metricName: 'aws.omics.task.gpu.memory.usage', role: 'usage' },
    { metricName: 'aws.omics.task.gpu.memory.limit', role: 'limit' },
  ],
  RUN_FILESYSTEM: [
    { metricName: 'aws.omics.run.filesystem.usage', role: 'usage' },
    { metricName: 'aws.omics.run.filesystem.limit', role: 'limit' },
  ],
};

/** One concrete metric to query, tagged with the family/role it belongs to. */
export interface MetricSelector {
  metricName: string;
  family: MetricFamily;
  role: MetricRole;
}

/**
 * Expand a requested family list into the concrete `{ metricName, family,
 * role }` selectors to query.
 *
 * - `families` defaults to {@link CORE_FAMILIES} when `undefined` or `[]`
 *   (Req 8 "bound cost by default").
 * - Duplicate families in the input (or families that would otherwise produce
 *   duplicate selectors) are de-duplicated by `metricName` so the same metric
 *   is never queried twice.
 * - Pure and total: unknown families are simply absent from
 *   {@link REGISTRY} and contribute no selectors.
 */
export function resolveSelectors(families?: MetricFamily[]): MetricSelector[] {
  const requested = families && families.length > 0 ? families : CORE_FAMILIES;

  const seen = new Set<string>();
  const selectors: MetricSelector[] = [];
  for (const family of requested) {
    const entries = REGISTRY[family] ?? [];
    for (const entry of entries) {
      if (seen.has(entry.metricName)) {
        continue;
      }
      seen.add(entry.metricName);
      selectors.push({ metricName: entry.metricName, family, role: entry.role });
    }
  }
  return selectors;
}
