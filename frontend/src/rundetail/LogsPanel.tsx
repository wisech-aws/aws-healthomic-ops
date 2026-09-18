/**
 * LogsPanel — shows CloudWatch logs for a selected step of a run, with client-
 * side search and severity filtering (QoL #2).
 *
 * The parent supplies which stream to show:
 *   - a selected task node -> that task's stream (stream="TASK" + taskId)
 *   - the run header "View run & engine logs" -> RUN and ENGINE (in tabs)
 *
 * Fetches once on mount / when the target changes, with its own Refresh button.
 * Bioinformaticians scan logs for errors, warnings, and specific process names,
 * so the panel offers a free-text search and a severity filter applied over the
 * fetched events. Logs are read-only; no data is written anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Spinner from '@cloudscape-design/components/spinner';
import Alert from '@cloudscape-design/components/alert';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { getRunLogs as defaultGetRunLogs } from '../api/client';
import type { LogEvent, LogStream, RunLogs } from '../api/types';

type Phase = 'loading' | 'error' | 'ready';

/** Severity filter options. */
type Severity = 'ALL' | 'ERROR' | 'WARN';

const SEVERITY_OPTIONS: SelectProps.Option[] = [
  { label: 'All levels', value: 'ALL' },
  { label: 'Errors only', value: 'ERROR' },
  { label: 'Warnings & errors', value: 'WARN' },
];

/** Case-insensitive matchers for severity. */
const ERROR_RE = /\b(error|err|exception|fatal|fail(ed|ure)?|traceback)\b/i;
const WARN_RE = /\b(warn(ing)?)\b/i;

function matchesSeverity(message: string, severity: Severity): boolean {
  if (severity === 'ALL') return true;
  if (severity === 'ERROR') return ERROR_RE.test(message);
  // WARN = warnings OR errors (errors are at least as important as warnings).
  return WARN_RE.test(message) || ERROR_RE.test(message);
}

export interface LogsPanelProps {
  readonly runId: string;
  readonly stream: LogStream;
  readonly taskId?: string;
  /** Injectable for tests; defaults to the real client. */
  readonly getRunLogs?: (v: {
    runId: string;
    stream: LogStream;
    taskId?: string;
    nextToken?: string;
    limit?: number;
  }) => Promise<RunLogs>;
}

function formatTs(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

export default function LogsPanel({
  runId,
  stream,
  taskId,
  getRunLogs = defaultGetRunLogs,
}: LogsPanelProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [streamName, setStreamName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState<Severity>('ALL');
  const preRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const result = await getRunLogs({ runId, stream, taskId });
      setEvents(result.events);
      setStreamName(result.logStreamName);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Logs could not be loaded.');
      setPhase('error');
    }
  }, [getRunLogs, runId, stream, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Apply severity + text filters over the fetched events (client-side).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter(
      (e) =>
        matchesSeverity(e.message, severity) &&
        (q === '' || e.message.toLowerCase().includes(q)),
    );
  }, [events, query, severity]);

  // Keep the newest lines in view when logs (re)load or the filter changes.
  useEffect(() => {
    if (phase === 'ready' && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [filtered, phase]);

  const selectedSeverity =
    SEVERITY_OPTIONS.find((o) => o.value === severity) ?? SEVERITY_OPTIONS[0];

  return (
    <SpaceBetween size="s">
      <SpaceBetween direction="horizontal" size="xs">
        <Button
          iconName="refresh"
          ariaLabel="Refresh logs"
          loading={phase === 'loading'}
          onClick={() => void load()}
        >
          Refresh logs
        </Button>
        <div style={{ minWidth: 220 }}>
          <Input
            type="search"
            value={query}
            placeholder="Search logs…"
            ariaLabel="Search logs"
            onChange={({ detail }) => setQuery(detail.value)}
          />
        </div>
        <Select
          selectedOption={selectedSeverity}
          options={SEVERITY_OPTIONS}
          ariaLabel="Filter by severity"
          onChange={({ detail }) =>
            setSeverity((detail.selectedOption.value as Severity) ?? 'ALL')
          }
        />
        {streamName && (
          <Box variant="small" color="text-status-inactive" padding={{ top: 'xs' }}>
            {streamName}
          </Box>
        )}
      </SpaceBetween>

      {phase === 'loading' && (
        <Box padding="s">
          <Spinner /> <span>Loading logs…</span>
        </Box>
      )}

      {phase === 'error' && (
        <Alert
          type="error"
          header="Logs could not be loaded"
          action={<Button onClick={() => void load()}>Retry</Button>}
        >
          {error}
        </Alert>
      )}

      {phase === 'ready' &&
        (events.length === 0 ? (
          <Box color="text-status-inactive" padding="s">
            No log events yet for this step.
          </Box>
        ) : filtered.length === 0 ? (
          <Box color="text-status-inactive" padding="s" data-testid="logs-no-match">
            No log lines match the current search / severity filter.
          </Box>
        ) : (
          <>
            <Box variant="small" color="text-status-inactive">
              Showing {filtered.length} of {events.length} lines
            </Box>
            <pre
              ref={preRef}
              data-testid="logs-output"
              style={{
                margin: 0,
                maxHeight: 360,
                overflow: 'auto',
                background: '#0f1b2d',
                color: '#e6edf3',
                padding: '12px',
                borderRadius: '6px',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: '12px',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {filtered
                .map((e) => `${formatTs(e.timestamp)}  ${e.message}`)
                .join('\n')}
            </pre>
          </>
        ))}
    </SpaceBetween>
  );
}
