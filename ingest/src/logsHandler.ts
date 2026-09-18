/**
 * Logs Lambda — AppSync Lambda-data-source resolver for run/task CloudWatch logs.
 *
 * The browser can only reach the AppSync GraphQL API, not CloudWatch Logs. This
 * Lambda backs two Cognito-authorized queries:
 *
 *   - `getRunLogs` — a raw page of log events for a selected step:
 *       - A task node -> that task's stream `run/<runId>/task/<taskId>` (stream="TASK").
 *       - The run header -> the run manifest stream `run/<runId>` (stream="RUN") and
 *         the Nextflow engine stream `run/<runId>/engine` (stream="ENGINE").
 *   - `getErrorExcerpt` — a best-effort extraction of the most relevant error
 *     lines from a run/task's log stream (Option B: HealthOmics' own
 *     `statusMessage` is frequently just boilerplate telling the operator to
 *     go read the CloudWatch logs themselves, with no actual diagnosis — see
 *     {@link extractErrorExcerpt} for the extraction strategy and the real
 *     failures it was validated against). Reads the WHOLE stream (paging
 *     through `GetLogEventsCommand`, oldest-first, up to a line budget) rather
 *     than a single page, since the real error is often thousands of lines
 *     before the stream's tail.
 *
 * HealthOmics writes all run logs to a single log group (default
 * `/aws/omics/WorkflowLog`), one stream per run/engine/task. The log group name
 * is provided via the `LOG_GROUP_NAME` environment variable so it is not
 * hardcoded.
 *
 * Both are invoked by AppSync as Lambda resolvers, so the event is the resolver
 * payload `{ arguments: {...} }`; `getRunLogs` returns
 * `{ events: [{ timestamp, message }], nextToken }` (the `RunLogs` GraphQL
 * type) and `getErrorExcerpt` returns `{ found, lines, truncated }` (the
 * `ErrorExcerpt` GraphQL type).
 */
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { extractErrorExcerpt, DEFAULT_MAX_EXCERPT_LINES } from './errorExcerpt.js';

/** The CloudWatch log group HealthOmics writes run logs to. */
const LOG_GROUP_NAME = process.env.LOG_GROUP_NAME ?? '/aws/omics/WorkflowLog';

/** Which stream the caller wants for a run. */
type LogStreamKind = 'RUN' | 'ENGINE' | 'TASK';

/** A single returned log event (mirrors the GraphQL `LogEvent` type). */
interface LogEvent {
  /** Epoch milliseconds the event was ingested/emitted. */
  timestamp: number;
  message: string;
}

/** The resolver result (mirrors the GraphQL `RunLogs` type). */
interface RunLogs {
  logStreamName: string;
  events: LogEvent[];
  nextToken: string | null;
}

/** The AppSync Lambda-resolver event shape for `getRunLogs`. */
interface GetRunLogsEvent {
  arguments: {
    runId: string;
    stream: LogStreamKind;
    taskId?: string | null;
    nextToken?: string | null;
    limit?: number | null;
  };
}

/** Clamp the requested page size to a safe range (default 200, max 1000). */
function resolveLimit(limit: number | null | undefined): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    return 200;
  }
  return Math.min(Math.max(Math.floor(limit), 1), 1000);
}

/**
 * Derive the CloudWatch log stream name for a run + stream kind.
 *
 * HealthOmics stream naming (confirm against AWS docs if it changes):
 *   RUN    -> `run/<runId>`
 *   ENGINE -> `run/<runId>/engine`
 *   TASK   -> `run/<runId>/task/<taskId>`
 */
function streamNameFor(
  runId: string,
  stream: LogStreamKind,
  taskId: string | null | undefined,
): string {
  switch (stream) {
    case 'ENGINE':
      return `run/${runId}/engine`;
    case 'TASK':
      if (!taskId) {
        throw new Error('taskId is required when stream is "TASK"');
      }
      return `run/${runId}/task/${taskId}`;
    case 'RUN':
    default:
      return `run/${runId}`;
  }
}

const client = new CloudWatchLogsClient({});

/**
 * AppSync Lambda resolver for `getRunLogs`. Reads a page of log events from the
 * derived stream, oldest-first, and returns them with a forward pagination
 * token. A missing stream (e.g. a task that has not started logging yet) is not
 * an error: it returns an empty page so the UI can show "no logs yet".
 */
export async function handler(event: GetRunLogsEvent): Promise<RunLogs> {
  const { runId, stream, taskId, nextToken, limit } = event.arguments;

  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('runId is required');
  }

  const logStreamName = streamNameFor(runId, stream, taskId);

  try {
    const response = await client.send(
      new GetLogEventsCommand({
        logGroupName: LOG_GROUP_NAME,
        logStreamName,
        limit: resolveLimit(limit),
        startFromHead: true,
        nextToken: nextToken ?? undefined,
      }),
    );

    const events: LogEvent[] = (response.events ?? []).map((e) => ({
      timestamp: e.timestamp ?? 0,
      message: e.message ?? '',
    }));

    // CloudWatch returns the same forward token when the stream end is reached;
    // surface it so the client can poll for more as the run progresses.
    return {
      logStreamName,
      events,
      nextToken: response.nextForwardToken ?? null,
    };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      // Stream doesn't exist yet (e.g. task not started): empty page, not error.
      return { logStreamName, events: [], nextToken: null };
    }
    throw err;
  }
}

/** Result of `getErrorExcerpt` (mirrors the GraphQL `ErrorExcerpt` type). */
interface ErrorExcerptResult {
  found: boolean;
  lines: string[];
  truncated: boolean;
}

/** The AppSync Lambda-resolver event shape for `getErrorExcerpt`. */
interface GetErrorExcerptEvent {
  arguments: {
    runId: string;
    stream: LogStreamKind;
    taskId?: string | null;
  };
}

/**
 * Safety cap on how many `GetLogEventsCommand` pages {@link fetchAllLines} will
 * fetch for a single `getErrorExcerpt` call, bounding worst-case Lambda
 * duration/cost against a pathologically large stream. At the API's own
 * per-page cap (10,000 events) this is up to 100,000 lines, comfortably beyond
 * the ~70,000-line engine log that motivated this feature.
 */
const MAX_EXCERPT_FETCH_PAGES = 10;

/** Max events requested per page when scanning a whole stream for an excerpt. */
const EXCERPT_PAGE_SIZE = 10_000;

/**
 * Fetch an entire CloudWatch log stream's messages, oldest-first, paging
 * through {@link EXCERPT_PAGE_SIZE}-event pages up to {@link
 * MAX_EXCERPT_FETCH_PAGES} pages. CloudWatch signals "no more pages" by
 * returning the SAME `nextForwardToken` it was given, so that is the loop's
 * stopping condition (matching `getRunLogs`'s existing token semantics).
 *
 * Returns an empty array (never throws) when the stream does not exist yet —
 * the caller treats that as "no excerpt found", not an error.
 */
async function fetchAllLines(logStreamName: string): Promise<string[]> {
  const lines: string[] = [];
  let token: string | undefined;

  for (let page = 0; page < MAX_EXCERPT_FETCH_PAGES; page += 1) {
    let response;
    try {
      response = await client.send(
        new GetLogEventsCommand({
          logGroupName: LOG_GROUP_NAME,
          logStreamName,
          limit: EXCERPT_PAGE_SIZE,
          startFromHead: true,
          nextToken: token,
        }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return lines;
      }
      throw err;
    }

    for (const e of response.events ?? []) {
      lines.push(e.message ?? '');
    }

    const next = response.nextForwardToken;
    if (next == null || next === token) {
      // No further pages: either no token at all, or CloudWatch echoed the
      // same token back (its documented "stream end" signal).
      break;
    }
    token = next;
  }

  return lines;
}

/**
 * AppSync Lambda resolver for `getErrorExcerpt` (Option B: surface the actual
 * error, not just HealthOmics' own often-generic `statusMessage`). Reads the
 * WHOLE named stream (bounded by {@link MAX_EXCERPT_FETCH_PAGES}) and runs
 * {@link extractErrorExcerpt} over it. A missing stream, or a stream with no
 * error-shaped lines, returns `{ found: false, lines: [], truncated: false }`
 * — never a fabricated excerpt.
 */
export async function errorExcerptHandler(
  event: GetErrorExcerptEvent,
): Promise<ErrorExcerptResult> {
  const { runId, stream, taskId } = event.arguments;

  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('runId is required');
  }

  const logStreamName = streamNameFor(runId, stream, taskId);
  const lines = await fetchAllLines(logStreamName);
  return extractErrorExcerpt(lines, DEFAULT_MAX_EXCERPT_LINES);
}

/**
 * Shared shape of the AppSync direct-Lambda-resolver context this function is
 * invoked with: both `getRunLogs` and `getErrorExcerpt` are wired as direct
 * Lambda resolvers (no request/response mapping template), so AppSync passes
 * the ENTIRE resolver context — including `info.fieldName`, which field is
 * currently being resolved — not just `arguments` (confirmed against the AWS
 * AppSync direct-Lambda-resolver reference).
 */
interface RouterEvent {
  arguments: Record<string, unknown>;
  info?: { fieldName?: string };
}

/**
 * Lambda entry point for BOTH `getRunLogs` and `getErrorExcerpt`: this single
 * physical function backs both GraphQL fields (they share the same CloudWatch
 * Logs IAM grant), so it dispatches on `event.info.fieldName` to the right
 * implementation. Unrecognized/absent field names default to the `getRunLogs`
 * behavior for backward compatibility with the pre-existing direct-invoke
 * shape (`{ arguments: {...} }` with no `info`), which is also exactly the
 * shape the existing `getRunLogs`-only test suite already exercises.
 */
export async function router(event: RouterEvent): Promise<unknown> {
  if (event.info?.fieldName === 'getErrorExcerpt') {
    return errorExcerptHandler(event as GetErrorExcerptEvent);
  }
  return handler(event as GetRunLogsEvent);
}
