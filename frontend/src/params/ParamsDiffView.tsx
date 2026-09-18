/**
 * Two-run parameters diff view (Cloudscape) (enhancement 6, Req 6.5, 6.7).
 *
 * Given two run ids, queries `getRun` for each exactly once (Req 10.4) and
 * renders the flattened parameters diff produced by {@link diffRunParameters}:
 *
 *  - A Cloudscape Table lists one row per key in the union of the two runs'
 *    flattened parameters, sorted by key, with each row styled by its diff
 *    kind — added / removed / changed / unchanged — via a status Badge and the
 *    left/right values (Req 6.1–6.4).
 *  - A per-side parse-error notice (Cloudscape Alert) is shown whenever a run's
 *    `parameters` was a present-but-non-JSON string (`leftParseError` /
 *    `rightParseError`) so the failure is surfaced rather than swallowed
 *    (Req 6.5).
 *  - A cross-workflow warning (Cloudscape Alert) is shown when the two runs do
 *    not share the same non-null `workflowId` (`sameWorkflow` is false) so the
 *    operator knows the comparison spans different workflows (Req 6.7).
 *
 * It handles the loading (Req 10.1), error-with-retry (Req 10.2), and
 * not-found states through a Spinner, a Cloudscape Alert with a retry action,
 * and an explicit not-found Alert respectively. The view is read-only and
 * never fabricates data: a missing run is reported, not invented.
 *
 * Following {@link RunDetailView}, the `getRun` data function is injectable so
 * tests (and later wiring) can supply a stub; it defaults to the real client.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Table from '@cloudscape-design/components/table';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { getRun as defaultGetRun } from '../api/client';
import type { Run } from '../api/types';
import {
  diffRunParameters,
  type DiffKind,
  type ParamDiffEntry,
  type ParamsDiffResult,
} from './paramsDiff';

/** Loading/error/ready phases of the initial `getRun` queries (Req 10.1–10.3). */
type LoadPhase = 'loading' | 'error' | 'ready';

/** Cloudscape Badge color per diff kind, keeping the four kinds visually distinct. */
const KIND_BADGE_COLOR: Record<DiffKind, 'green' | 'red' | 'blue' | 'grey'> = {
  added: 'green',
  removed: 'red',
  changed: 'blue',
  unchanged: 'grey',
};

/** Human-readable label per diff kind for the status column. */
const KIND_LABEL: Record<DiffKind, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  unchanged: 'Unchanged',
};

/**
 * Props for {@link ParamsDiffView}. The `getRun` data function is injectable so
 * tests (and a later real wiring) can supply a stub; it defaults to the real
 * client. The view compares the two runs identified by `leftRunId` (the "left"
 * / base run) and `rightRunId` (the "right" / compared run).
 */
export interface ParamsDiffViewProps {
  /** The base ("left") run to compare. */
  readonly leftRunId: string;
  /** The compared ("right") run to compare against the base. */
  readonly rightRunId: string;
  /** Invoked when the operator chooses to return to the previous view. */
  readonly onBack?: () => void;
  readonly getRun?: (runId: string) => Promise<Run | null>;
}

/** Renders a single diff value cell: `—` for absent, else its JSON/text form. */
function ValueCell({ value }: { value: unknown }): React.JSX.Element {
  if (value === undefined) {
    return <Box variant="samp" color="text-status-inactive">—</Box>;
  }
  const text =
    value === null
      ? 'null'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return <Box variant="samp">{text}</Box>;
}

/** The diff status Badge for one entry (Req 6.3). */
function KindCell({ kind }: { kind: DiffKind }): React.JSX.Element {
  return (
    <span aria-label={`change ${kind}`} data-testid={`diff-kind-${kind}`}>
      <Badge color={KIND_BADGE_COLOR[kind]}>{KIND_LABEL[kind]}</Badge>
    </span>
  );
}

export default function ParamsDiffView({
  leftRunId,
  rightRunId,
  onBack,
  getRun = defaultGetRun,
}: ParamsDiffViewProps): React.JSX.Element {
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [leftRun, setLeftRun] = useState<Run | null>(null);
  const [rightRun, setRightRun] = useState<Run | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Guards the "query exactly once per mount" contract (Req 10.4) against React
  // StrictMode double-invocation of effects in development.
  const hasQueried = useRef(false);

  const load = useCallback(async () => {
    setPhase('loading');
    setErrorMessage(null);
    try {
      const [loadedLeft, loadedRight] = await Promise.all([
        getRun(leftRunId),
        getRun(rightRunId),
      ]);
      setLeftRun(loadedLeft);
      setRightRun(loadedRight);
      setPhase('ready');
    } catch (error) {
      // Retain previously loaded content; only swap in the error state (Req 10.2).
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Run parameters could not be loaded.',
      );
      setPhase('error');
    }
  }, [getRun, leftRunId, rightRunId]);

  useEffect(() => {
    if (hasQueried.current) {
      return;
    }
    hasQueried.current = true;
    void load();
  }, [load]);

  // Retry re-issues the queries on demand (Req 10.2). Allowed because it is a
  // user-initiated action, not the automatic per-mount query.
  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  // The diff is only meaningful once both runs are loaded; recomputed whenever
  // either run changes. Kept null until both are present so the render below can
  // distinguish "not found" from "ready".
  const diff = useMemo<ParamsDiffResult | null>(
    () =>
      leftRun != null && rightRun != null
        ? diffRunParameters(leftRun, rightRun)
        : null,
    [leftRun, rightRun],
  );

  const headerActions = onBack ? (
    <Button iconName="arrow-left" onClick={onBack}>
      Back
    </Button>
  ) : undefined;

  const header = (
    <Header variant="h1" actions={headerActions}>
      Parameters diff
    </Header>
  );

  if (phase === 'loading') {
    return (
      <Container header={header}>
        <div aria-label="parameters diff">
          <Box padding="l" textAlign="center">
            <Spinner size="large" />{' '}
            <span role="status">Loading run parameters…</span>
          </Box>
        </div>
      </Container>
    );
  }

  if (phase === 'error') {
    return (
      <Container header={header}>
        <Alert
          type="error"
          header="Run parameters could not be loaded"
          action={<Button onClick={handleRetry}>Retry</Button>}
        >
          <span aria-label="parameters diff">
            {errorMessage ?? 'Run parameters could not be loaded.'}
          </span>
        </Alert>
      </Container>
    );
  }

  // Ready but one or both runs were not found: report it rather than fabricate
  // an empty diff (Req 10.1).
  if (diff == null) {
    const missing = [
      leftRun == null ? leftRunId : null,
      rightRun == null ? rightRunId : null,
    ].filter((id): id is string => id != null);
    return (
      <Container header={header}>
        <Alert type="error" header="Run not found">
          <span aria-label="parameters diff">
            {`No run found for ${missing.join(' and ')}.`}
          </span>
        </Alert>
      </Container>
    );
  }

  return (
    <Container header={header}>
      <SpaceBetween size="l">
        <div aria-label="parameters diff">
          <SpaceBetween size="m">
            {/* Cross-workflow warning (Req 6.7): the two runs do not share the
                same workflow, so parameter keys may not be comparable. */}
            {!diff.sameWorkflow && (
              <Alert
                type="warning"
                header="Comparing runs of different workflows"
                data-testid="cross-workflow-warning"
              >
                <span aria-label="cross workflow warning">
                  These runs are not from the same workflow, so their parameters
                  may not be directly comparable.
                </span>
              </Alert>
            )}

            {/* Per-side parse-error notices (Req 6.5): a present-but-non-JSON
                `parameters` string is surfaced, not swallowed. */}
            {diff.leftParseError && (
              <Alert
                type="error"
                header="Left run parameters could not be parsed"
                data-testid="left-parse-error"
              >
                <span aria-label="left parse error">
                  {`The parameters for run ${leftRunId} are not valid JSON; that side is treated as having no parameters.`}
                </span>
              </Alert>
            )}
            {diff.rightParseError && (
              <Alert
                type="error"
                header="Right run parameters could not be parsed"
                data-testid="right-parse-error"
              >
                <span aria-label="right parse error">
                  {`The parameters for run ${rightRunId} are not valid JSON; that side is treated as having no parameters.`}
                </span>
              </Alert>
            )}
          </SpaceBetween>
        </div>

        <Table<ParamDiffEntry>
          variant="borderless"
          items={diff.entries}
          trackBy="key"
          header={
            <Header variant="h2" counter={`(${diff.entries.length})`}>
              Parameter changes
            </Header>
          }
          empty={
            <Box textAlign="center" color="inherit">
              <b>No parameters to compare.</b>
            </Box>
          }
          ariaLabels={{ tableLabel: 'Parameter changes' }}
          columnDefinitions={[
            {
              id: 'change',
              header: 'Change',
              cell: (entry) => <KindCell kind={entry.kind} />,
            },
            {
              id: 'key',
              header: 'Parameter',
              cell: (entry) => <Box variant="samp">{entry.key}</Box>,
            },
            {
              id: 'left',
              header: `Left (${leftRunId})`,
              cell: (entry) => <ValueCell value={entry.left} />,
            },
            {
              id: 'right',
              header: `Right (${rightRunId})`,
              cell: (entry) => <ValueCell value={entry.right} />,
            },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}
