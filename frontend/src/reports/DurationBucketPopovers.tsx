/**
 * Clickable duration-bucket controls for the Reports view's duration histogram.
 *
 * WHY A PARALLEL CONTROL (not the chart's built-in detail popover): the pinned
 * `@cloudscape-design/components@3.0.1356` `BarChart` exposes no interactable
 * `detailPopoverContent(datum, series) => ReactNode` render prop — only
 * `detailPopoverSeriesContent` (which must return a `{ key, value }` pair, not
 * arbitrary clickable content) and `detailPopoverFooter`. Its hover/pinned
 * detail popover is not a reliable place to host clickable run links. So we
 * KEEP the `BarChart` as the visual and render this parallel row of
 * click-triggered Cloudscape `Popover`s — one per NON-EMPTY bucket — each
 * listing the runs that fall in that bucket's duration range, where each run is
 * a hyperlink that opens in a NEW BROWSER TAB. This is deterministic and
 * unit-testable, and matches the bars one-to-one.
 */
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Link from '@cloudscape-design/components/link';
import Popover from '@cloudscape-design/components/popover';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { HistogramBucket, RunPoint } from '../api/types';
import { serializeViewHash } from '../navigation/viewHash';
import { formatDurationMs } from './durationBuckets';

/** Max run links rendered in a single bucket popover; the rest are summarized. */
const MAX_VISIBLE_RUNS = 50;

/** Minutes label for a millisecond bound, matching the BarChart x labels. */
function toMin(ms: number): number {
  return Math.round(ms / 60000);
}

/**
 * Absolute in-app URL (incl. deep-link hash) for a run, so a new-tab link lands
 * on that run's detail view. Reuses `serializeViewHash` to avoid drift from the
 * app's `#/run/<runId>` scheme.
 */
export function runHref(runId: string): string {
  return `${window.location.origin}${window.location.pathname}${serializeViewHash({
    kind: 'run',
    runId,
  })}`;
}

export interface DurationBucketPopoversProps {
  readonly buckets: readonly HistogramBucket[];
  /** Index-aligned to `buckets`: the runs that fall in each bucket. */
  readonly runsByBucket: readonly (readonly RunPoint[])[];
}

/** The run list rendered inside a single bucket's popover. */
function BucketRunList({
  runs,
}: {
  readonly runs: readonly RunPoint[];
}): React.JSX.Element {
  const visible = runs.slice(0, MAX_VISIBLE_RUNS);
  const overflow = runs.length - visible.length;
  return (
    <SpaceBetween size="xs">
      {visible.map((run) => (
        <div key={run.runId}>
          <Link
            external
            href={runHref(run.runId)}
            target="_blank"
            data-testid="reports-bucket-run-link"
          >
            {run.runId}
          </Link>
          <Box variant="span" color="text-body-secondary" fontSize="body-s">
            {run.status != null ? ` · ${run.status}` : ''}
            {typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)
              ? ` · ${formatDurationMs(run.durationMs)}`
              : ''}
          </Box>
        </div>
      ))}
      {overflow > 0 && (
        <Box variant="span" color="text-body-secondary" fontSize="body-s">
          + {overflow} more
        </Box>
      )}
    </SpaceBetween>
  );
}

/**
 * A COLLAPSIBLE (collapsed-by-default) browser of one click-triggered popover
 * per NON-EMPTY bucket, laid out in a grid of ~7 per row. A zero-run bucket
 * renders no trigger (nothing to list). Each trigger is labeled with the
 * bucket's minute range + run count; opening it reveals that bucket's runs as
 * new-tab hyperlinks. When no bucket has runs, nothing (not even an empty
 * section) is rendered.
 */
export default function DurationBucketPopovers({
  buckets,
  runsByBucket,
}: DurationBucketPopoversProps): React.JSX.Element | null {
  const triggers = buckets
    .map((bucket, i) => ({ bucket, runs: runsByBucket[i] ?? [] }))
    .filter(({ runs }) => runs.length > 0);

  if (triggers.length === 0) {
    return null;
  }

  const totalRunsAcrossBuckets = triggers.reduce((sum, t) => sum + t.runs.length, 0);

  return (
    <ExpandableSection
      data-testid="reports-bucket-section"
      defaultExpanded={false}
      headerText={`Browse runs by duration bucket (${totalRunsAcrossBuckets} runs across ${triggers.length} buckets)`}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: '8px',
        }}
      >
        {triggers.map(({ bucket, runs }) => {
          const label = `${toMin(bucket.lo)}–${toMin(bucket.hi)} min (${runs.length})`;
          const header = `Runs in ${toMin(bucket.lo)}–${toMin(bucket.hi)} min — ${runs.length} run${
            runs.length === 1 ? '' : 's'
          }`;
          return (
            <Popover
              key={`${bucket.lo}-${bucket.hi}`}
              position="top"
              size="large"
              triggerType="custom"
              dismissButton
              header={header}
              content={<BucketRunList runs={runs} />}
            >
              <Button variant="inline-link" data-testid="reports-bucket-trigger">
                {label}
              </Button>
            </Popover>
          );
        })}
      </div>
    </ExpandableSection>
  );
}
