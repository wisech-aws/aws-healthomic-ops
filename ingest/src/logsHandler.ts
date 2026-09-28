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
import { NodeHttpHandler } from '@smithy/node-http-handler';
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
    /**
     * OPT-IN tail mode (failed-run triage). When `true`, fetch the NEWEST slice
     * of the stream first (`startFromHead: false`) and page OLDER on demand via
     * the backward token, so the error at the end of a huge FAILED-run stream is
     * reached immediately. Falsy/absent keeps the default oldest-first behavior.
     */
    tail?: boolean | null;
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

/**
 * CloudWatch Logs client with explicit connection/request timeouts and retries.
 *
 * WHY: `getRunLogs` was intermittently hanging for the full Lambda timeout
 * (Duration 30000ms, Status: timeout), which surfaced in the browser as an
 * aborted request (Firefox `NS_BINDING_ABORTED`). Most calls returned in ~1-2s
 * and direct Lambda invokes were ~1.2s, so `GetLogEvents` itself is fast — the
 * 30s hangs were STALLED socket connections with no client-side timeout to fail
 * fast, so nothing bounded them below the Lambda's 30s ceiling.
 *
 * The default `new CloudWatchLogsClient({})` sets no request/connection timeout,
 * so a stalled socket rides all the way to the Lambda timeout. Bounding the
 * connection (3s) and socket/response (8s) timeouts makes a stalled request fail
 * fast, and `maxAttempts: 3` lets the SDK retry it (with backoff) within budget:
 * 8s x up to 3 attempts stays comfortably under the 30s Lambda timeout while
 * still giving a genuinely slow-but-live request room to complete.
 *
 * `fetchTailLines` (the `getErrorExcerpt` path) shares this same client, so it
 * inherits the same fail-fast behavior — desirable for that path too.
 */
const client = new CloudWatchLogsClient({
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 3000,
    requestTimeout: 8000,
  }),
  maxAttempts: 3,
});

/**
 * AppSync Lambda resolver for `getRunLogs`. Reads a page of log events from the
 * derived stream and returns them with a pagination token. A missing stream
 * (e.g. a task that has not started logging yet) is not an error: it returns an
 * empty page so the UI can show "no logs yet".
 *
 * The optional `tail` argument is OPT-IN and intended for FAILED-run triage:
 *
 *   - `tail` falsy/absent (DEFAULT): oldest-first (`startFromHead: true`), with
 *     forward pagination via `nextForwardToken`. This is the behavior for a
 *     successful run's logs and is byte-for-byte identical to the pre-tail
 *     code path — the client polls the returned forward token for more lines as
 *     the run progresses.
 *   - `tail === true`: newest-first (`startFromHead: false`), returning the
 *     LATEST slice of the stream immediately rather than reading from the head.
 *     The returned token is the BACKWARD token so the client can page OLDER on
 *     demand. Events within the returned page stay in the ascending order
 *     CloudWatch returns them (the `<pre>` still reads top→bottom oldest→newest
 *     for that slice); the win is that the latest slice is fetched first, not
 *     the whole stream from the head.
 */
export async function handler(event: GetRunLogsEvent): Promise<RunLogs> {
  const { runId, stream, taskId, nextToken, limit, tail } = event.arguments;

  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('runId is required');
  }

  const logStreamName = streamNameFor(runId, stream, taskId);

  // Opt-in tail: newest-first fetch (`startFromHead: false`) for failed-run
  // triage. Anything falsy keeps the default oldest-first (`startFromHead:
  // true`) semantics untouched.
  const tailing = tail === true;

  try {
    const response = await client.send(
      new GetLogEventsCommand({
        logGroupName: LOG_GROUP_NAME,
        logStreamName,
        limit: resolveLimit(limit),
        startFromHead: !tailing,
        nextToken: nextToken ?? undefined,
      }),
    );

    const events: LogEvent[] = (response.events ?? []).map((e) => ({
      timestamp: e.timestamp ?? 0,
      message: e.message ?? '',
    }));

    // Default (oldest-first): CloudWatch returns the same FORWARD token when the
    // stream end is reached; surface it so the client can poll for more as the
    // run progresses. Tail (newest-first): surface the BACKWARD token so the
    // client can page OLDER on demand.
    return {
      logStreamName,
      events,
      nextToken:
        (tailing ? response.nextBackwardToken : response.nextForwardToken) ??
        null,
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
 * Safety cap on how many `GetLogEventsCommand` pages {@link fetchTailLines}
 * will fetch (walking BACKWARD from the newest slice) for a single
 * `getErrorExcerpt` call, bounding worst-case Lambda duration/cost.
 *
 * WHY THIS IS SMALL: {@link extractErrorExcerpt} is a TAIL-oriented heuristic —
 * it locates the trailing stack-frame run (walking backward to its headline),
 * or failing that the LAST contiguous run of error-shaped lines. It only ever
 * inspects the END of the stream, so reading the whole stream front-to-back
 * (the previous behavior) fetched up to ~70,000 lines over ~7 serial CloudWatch
 * round-trips (~15s, the "Run failed" panel's slow excerpt render) only to
 * discard everything but the tail. Fetching the newest slice first
 * (`startFromHead: false`) gives the extractor exactly the region it uses in a
 * single round-trip. The small backward page budget below only exists so an
 * error region that straddles a page boundary is still fully captured; it is
 * NOT a whole-stream scan.
 */
const MAX_EXCERPT_FETCH_PAGES = 3;

/** Max events requested per page when reading the stream tail for an excerpt. */
const EXCERPT_PAGE_SIZE = 10_000;

/**
 * Fetch the TAIL of a CloudWatch log stream's messages, returned oldest-first
 * (the order {@link extractErrorExcerpt} expects). Reads the newest slice first
 * (`startFromHead: false`) and, only if needed, walks OLDER via the backward
 * token up to {@link MAX_EXCERPT_FETCH_PAGES} pages. CloudWatch signals "no
 * more pages" by returning the SAME `nextBackwardToken` it was given, so that
 * is the loop's stopping condition (mirroring `getRunLogs`'s token semantics).
 *
 * Because we page from newest→oldest but the extractor wants oldest→newest,
 * each page's events (which CloudWatch returns ascending within the page) are
 * PREPENDED, so the assembled array reads oldest→newest overall.
 *
 * Returns an empty array (never throws) when the stream does not exist yet —
 * the caller treats that as "no excerpt found", not an error.
 */
async function fetchTailLines(logStreamName: string): Promise<string[]> {
  let lines: string[] = [];
  let token: string | undefined;

  for (let page = 0; page < MAX_EXCERPT_FETCH_PAGES; page += 1) {
    let response;
    try {
      response = await client.send(
        new GetLogEventsCommand({
          logGroupName: LOG_GROUP_NAME,
          logStreamName,
          limit: EXCERPT_PAGE_SIZE,
          // Newest slice first: the error the extractor wants lives at the tail.
          startFromHead: false,
          nextToken: token,
        }),
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) {
        return lines;
      }
      throw err;
    }

    // Events within a page are ascending (oldest→newest). We are walking pages
    // from newest→oldest, so prepend each page to keep the whole array
    // oldest→newest for the extractor.
    const pageLines = (response.events ?? []).map((e) => e.message ?? '');
    lines = pageLines.concat(lines);

    const next = response.nextBackwardToken;
    if (next == null || next === token) {
      // No older pages: either no token at all, or CloudWatch echoed the same
      // backward token back (its documented "start of stream" signal).
      break;
    }
    token = next;
  }

  return lines;
}

/**
 * AppSync Lambda resolver for `getErrorExcerpt` (Option B: surface the actual
 * error, not just HealthOmics' own often-generic `statusMessage`). Reads the
 * TAIL of the named stream (newest slice first, bounded by {@link
 * MAX_EXCERPT_FETCH_PAGES}) and runs {@link extractErrorExcerpt} over it — the
 * extractor is tail-oriented, so a single newest-first fetch reaches the error
 * immediately instead of scanning the whole stream front-to-back. A missing
 * stream, or a stream with no error-shaped lines, returns
 * `{ found: false, lines: [], truncated: false }` — never a fabricated excerpt.
 */
export async function errorExcerptHandler(
  event: GetErrorExcerptEvent,
): Promise<ErrorExcerptResult> {
  const { runId, stream, taskId } = event.arguments;

  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('runId is required');
  }

  const logStreamName = streamNameFor(runId, stream, taskId);
  const lines = await fetchTailLines(logStreamName);
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
