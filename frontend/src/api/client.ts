/**
 * GraphQL client for the HealthOmics Workflow Dashboard.
 *
 * Configures the Amplify v6 GraphQL client against the AppSync endpoint and
 * Cognito user pool from the injected build-time configuration (no hardcoded
 * environment values — Req 11.7). The API is deliberately split into:
 *
 *  - **one-shot query functions** (`listRuns`, `getRun`, `listTasksForRun`)
 *    that a view calls exactly once per mount to fetch initial data, and
 *  - **long-lived subscribe functions** (`onRunUpdated`, `onTaskUpdated`) that
 *    deliver every subsequent change.
 *
 * This shape makes the "query once per mount, then only subscriptions"
 * contract (Req 10.4) structural: there is no query function that a view is
 * meant to poll, and no subscribe function that returns initial state.
 */
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/api';
import type { GraphQLResult } from 'aws-amplify/api';
import { getApiConfig, isLocalMockMode } from './config';
import type {
  ErrorExcerpt,
  LogStream,
  MetricFamily,
  Run,
  RunConnection,
  RunCostEstimate,
  RunLogs,
  RunMetrics,
  StaticGraph,
  Task,
  WorkflowGroup,
  WorkflowReport,
  RunPointConnection,
} from './types';
import {
  MOCK_GRAPHS_BY_RUN,
  MOCK_RUNS,
  MOCK_TASKS_BY_RUN,
  MOCK_WORKFLOW_GROUPS,
  mockWorkflowReport,
} from './mockData';

/**
 * Minimal observable shape for a GraphQL subscription. Declared locally so the
 * client depends only on the pinned `aws-amplify` public surface and not on the
 * transitive `@aws-amplify/api-graphql` type exports.
 */
interface SubscriptionObservable<T> {
  subscribe(observer: {
    next: (message: { data?: T }) => void;
    error?: (error: unknown) => void;
  }): { unsubscribe(): void };
}

/**
 * Configures Amplify from the injected build-time config. Idempotent: safe to
 * call more than once (only the first call performs configuration).
 */
let configured = false;
function ensureConfigured(): void {
  if (configured) {
    return;
  }
  const config = getApiConfig();
  Amplify.configure({
    API: {
      GraphQL: {
        endpoint: config.appsyncEndpoint,
        region: config.region,
        defaultAuthMode: 'userPool',
      },
    },
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });
  configured = true;
}

/**
 * Narrow view of the Amplify client's `graphql` method.
 *
 * The generated client's own `graphql` overloads resolve through deeply
 * recursive conditional/mapped types that overflow the checker for our
 * hand-written documents. We only ever pass a document string plus variables
 * and read back `data`, so we cast the client to this minimal contract and
 * apply precise types at each call site instead.
 */
interface RawGraphqlClient {
  graphql(operation: {
    query: string;
    variables?: Record<string, unknown>;
  }): unknown;
}

/** Lazily created singleton GraphQL client, viewed through the narrow contract. */
let client: RawGraphqlClient | undefined;
function getClient(): RawGraphqlClient {
  ensureConfigured();
  if (client === undefined) {
    client = generateClient() as unknown as RawGraphqlClient;
  }
  return client;
}

/**
 * Runs a query/mutation document and returns its typed `data`.
 *
 * The result is cast to the known response shape; this keeps precise payload
 * types for callers without engaging the client's branded fallback generics.
 */
async function runQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const result = (await getClient().graphql({
    query,
    variables,
  })) as GraphQLResult<T>;
  return result.data as T;
}

/** Opens a subscription document as a typed observable of `data` messages. */
function runSubscription<T>(
  query: string,
  variables?: Record<string, unknown>,
): SubscriptionObservable<T> {
  return getClient().graphql({
    query,
    variables,
  }) as SubscriptionObservable<T>;
}

// --- GraphQL documents -----------------------------------------------------

const LIST_RUNS = /* GraphQL */ `
  query ListRuns($limit: Int, $nextToken: String) {
    listRuns(limit: $limit, nextToken: $nextToken) {
      items {
        runId
        status
        name
        createdAt
        startedAt
        stoppedAt
        updatedAt
        workflowId
        workflowName
        workflowVersionName
        outputUri
        parameters
        engineVersion
        roleArn
        storageType
        storageCapacity
        cacheId
        cacheBehavior
        networkingMode
        configurationName
        logLevel
        batchId
        tags
        statusMessage
        failureReason
      }
      nextToken
    }
  }
`;

const GET_RUN = /* GraphQL */ `
  query GetRun($runId: ID!) {
    getRun(runId: $runId) {
      runId
      status
      name
      createdAt
      startedAt
      stoppedAt
      updatedAt
      workflowId
      workflowName
      workflowVersionName
      outputUri
      parameters
      engineVersion
      roleArn
      storageType
      storageCapacity
      cacheId
      cacheBehavior
      networkingMode
      configurationName
      logLevel
      batchId
      tags
      statusMessage
      failureReason
    }
  }
`;

const LIST_TASKS_FOR_RUN = /* GraphQL */ `
  query ListTasksForRun($runId: ID!) {
    listTasksForRun(runId: $runId) {
      runId
      taskId
      status
      name
      createdAt
      startedAt
      stoppedAt
      updatedAt
      cpus
      memory
      instanceType
      statusMessage
      failureReason
    }
  }
`;

const ON_RUN_UPDATED = /* GraphQL */ `
  subscription OnRunUpdated {
    onRunUpdated {
      runId
      status
      name
      createdAt
      startedAt
      stoppedAt
      updatedAt
      workflowId
      workflowName
      workflowVersionName
      outputUri
      parameters
      engineVersion
      roleArn
      storageType
      storageCapacity
      cacheId
      cacheBehavior
      networkingMode
      configurationName
      logLevel
      batchId
      tags
      statusMessage
      failureReason
    }
  }
`;

const ON_TASK_UPDATED = /* GraphQL */ `
  subscription OnTaskUpdated($runId: ID!) {
    onTaskUpdated(runId: $runId) {
      runId
      taskId
      status
      name
      createdAt
      startedAt
      stoppedAt
      updatedAt
      cpus
      memory
      instanceType
      statusMessage
      failureReason
    }
  }
`;

const GET_RUN_LOGS = /* GraphQL */ `
  query GetRunLogs(
    $runId: ID!
    $stream: LogStream!
    $taskId: ID
    $nextToken: String
    $limit: Int
    $tail: Boolean
  ) {
    getRunLogs(
      runId: $runId
      stream: $stream
      taskId: $taskId
      nextToken: $nextToken
      limit: $limit
      tail: $tail
    ) {
      logStreamName
      events {
        timestamp
        message
      }
      nextToken
    }
  }
`;

const GET_ERROR_EXCERPT = /* GraphQL */ `
  query GetErrorExcerpt($runId: ID!, $stream: LogStream!, $taskId: ID) {
    getErrorExcerpt(runId: $runId, stream: $stream, taskId: $taskId) {
      found
      lines
      truncated
    }
  }
`;

const GET_RUN_METRICS = /* GraphQL */ `
  query GetRunMetrics(
    $runId: ID!
    $startTime: String
    $endTime: String
    $stepSeconds: Int
    $families: [MetricFamily!]
  ) {
    getRunMetrics(
      runId: $runId
      startTime: $startTime
      endTime: $endTime
      stepSeconds: $stepSeconds
      families: $families
    ) {
      runId
      window { start end stepSeconds }
      series {
        metricName family role unit taskId direction scratchMode gpuId
        points { timestamp value }
      }
      error
    }
  }
`;

const GET_RUN_COST_ESTIMATE = /* GraphQL */ `
  query GetRunCostEstimate($runId: ID!) {
    getRunCostEstimate(runId: $runId) {
      runId
      lineItems {
        category
        usageType
        resourceType
        quantity
        unit
        ratePerUnit
        estimatedCost
        available
        unavailableReason
      }
      total
      currency
      effectiveDate
      partial
      error
    }
  }
`;

const GET_STATIC_GRAPH = /* GraphQL */ `
  query GetStaticGraph($workflowId: ID!, $workflowVersionName: String!) {
    getStaticGraph(workflowId: $workflowId, workflowVersionName: $workflowVersionName) {
      workflowId
      nodes { id name }
      edges { from to }
      fidelity
    }
  }
`;

const LIST_WORKFLOW_GROUPS = /* GraphQL */ `
  query ListWorkflowGroups($start: String!, $end: String!) {
    listWorkflowGroups(start: $start, end: $end) {
      workflowName
      versionName
      workflowIds
      runCount
    }
  }
`;

const GET_WORKFLOW_REPORT = /* GraphQL */ `
  query GetWorkflowReport(
    $workflowName: String!
    $versionName: String!
    $start: String!
    $end: String!
  ) {
    getWorkflowReport(
      workflowName: $workflowName
      versionName: $versionName
      start: $start
      end: $end
    ) {
      workflowName
      versionName
      window { start end stepSeconds }
      runCount
      succeeded
      failed
      cancelled
      collision
      metrics {
        key unit mean median p90 availableCount totalCount
      }
      durationHistogram {
        key unit availableCount totalCount
        buckets { lo hi count }
      }
      timeBins {
        start end runCount durationMeanMs durationP90Ms
      }
      sample {
        runId stoppedAt status durationMs meanCpu peakCpu
        meanMemoryGiB peakMemoryGiB cpuHours peakConcurrentTasks
        taskCount failedTaskCount
      }
      sampleCapped
    }
  }
`;

const LIST_WORKFLOW_RUN_POINTS = /* GraphQL */ `
  query ListWorkflowRunPoints(
    $workflowName: String!
    $versionName: String!
    $start: String!
    $end: String!
    $limit: Int
    $nextToken: String
  ) {
    listWorkflowRunPoints(
      workflowName: $workflowName
      versionName: $versionName
      start: $start
      end: $end
      limit: $limit
      nextToken: $nextToken
    ) {
      items {
        runId stoppedAt status durationMs meanCpu peakCpu
        meanMemoryGiB peakMemoryGiB cpuHours peakConcurrentTasks
        taskCount failedTaskCount
      }
      nextToken
    }
  }
`;

// --- Query/subscription payload shapes -------------------------------------

interface ListRunsData {
  listRuns: RunConnection;
}
interface GetRunData {
  getRun: Run | null;
}
interface ListTasksForRunData {
  listTasksForRun: Task[];
}
interface OnRunUpdatedData {
  onRunUpdated: Run;
}
interface OnTaskUpdatedData {
  onTaskUpdated: Task;
}
interface GetRunLogsData {
  getRunLogs: RunLogs | null;
}
interface GetErrorExcerptData {
  getErrorExcerpt: ErrorExcerpt | null;
}
interface GetRunMetricsData {
  getRunMetrics: RunMetrics;
}
interface GetRunCostEstimateData {
  getRunCostEstimate: RunCostEstimate;
}
interface GetStaticGraphData {
  getStaticGraph: StaticGraph | null;
}
interface ListWorkflowGroupsData {
  listWorkflowGroups: WorkflowGroup[];
}
interface GetWorkflowReportData {
  getWorkflowReport: WorkflowReport | null;
}
interface ListWorkflowRunPointsData {
  listWorkflowRunPoints: RunPointConnection | null;
}

// --- One-shot query functions (call exactly once per view mount, Req 10.4) --

/** Fetches a page of runs. Optional server-side limit and pagination cursor. */
export async function listRuns(
  variables: { limit?: number; nextToken?: string } = {},
): Promise<RunConnection> {
  if (isLocalMockMode()) {
    // Local mock mode: return sample data without configuring Amplify or
    // requiring a Cognito sign-in (no auth, no "No federated jwt").
    return { items: MOCK_RUNS, nextToken: null };
  }
  const data = await runQuery<ListRunsData>(LIST_RUNS, variables);
  return data.listRuns;
}

/** Fetches a single run by id. Returns null when no run matches (Req 5.7). */
export async function getRun(runId: string): Promise<Run | null> {
  if (isLocalMockMode()) {
    return MOCK_RUNS.find((run) => run.runId === runId) ?? null;
  }
  const data = await runQuery<GetRunData>(GET_RUN, { runId });
  return data.getRun;
}

/** Fetches all tasks for a run (empty list when the run has no tasks). */
export async function listTasksForRun(runId: string): Promise<Task[]> {
  if (isLocalMockMode()) {
    return MOCK_TASKS_BY_RUN[runId] ?? [];
  }
  const data = await runQuery<ListTasksForRunData>(LIST_TASKS_FOR_RUN, {
    runId,
  });
  return data.listTasksForRun;
}

/**
 * Fetches the source-derived static graph for a workflow version, or `null`
 * when none is cached (the run detail view then falls back to the Inferred
 * DAG). Callers pass `run.workflowVersionName ?? 'DEFAULT'` for the version.
 *
 * In local mock mode there is no version-qualified backing store, so the mock
 * graphs (which are keyed by run in {@link MOCK_GRAPHS_BY_RUN}) are looked up
 * by their carried `workflowId` — the least-surprising honest mapping, since
 * each mock graph already records the workflow it belongs to. The version name
 * is ignored in mock mode as the fixtures model a single version per workflow.
 */
export async function getStaticGraph(
  workflowId: string,
  workflowVersionName: string,
): Promise<StaticGraph | null> {
  if (isLocalMockMode()) {
    const mock = Object.values(MOCK_GRAPHS_BY_RUN).find(
      (graph) => graph.workflowId === workflowId,
    );
    if (mock === undefined) {
      return null;
    }
    // The mock (view) StaticGraph carries an optional `fidelity`; normalize to
    // the API shape's required field, defaulting a missing value to the
    // best-effort `approximate` — the same convention the backend and view use
    // for legacy/absent fidelity.
    return { ...mock, fidelity: mock.fidelity ?? 'approximate' };
  }
  const data = await runQuery<GetStaticGraphData>(GET_STATIC_GRAPH, {
    workflowId,
    workflowVersionName,
  });
  return data.getStaticGraph;
}

/**
 * Fetches a page of CloudWatch log events for a step of a run (Cognito-authed,
 * backed by a Lambda data source over the HealthOmics log group).
 *
 *   - stream 'RUN'    -> the run manifest stream
 *   - stream 'ENGINE' -> the Nextflow engine (staging/process) stream
 *   - stream 'TASK'   -> a specific task's stream (requires `taskId`)
 *
 * Returns an empty page when the stream doesn't exist yet (e.g. a task that has
 * not started logging). In local mock mode returns an empty page (no backend).
 */
export async function getRunLogs(variables: {
  runId: string;
  stream: LogStream;
  taskId?: string;
  nextToken?: string;
  limit?: number;
  /**
   * OPT-IN tail mode (failed-run triage): when true, the backend fetches the
   * newest slice of the stream first. Absent/false keeps the default
   * oldest-first behavior; AppSync treats an absent Boolean as null, which the
   * backend reads as falsy — so successful-run retrieval is unchanged.
   */
  tail?: boolean;
}): Promise<RunLogs> {
  if (isLocalMockMode()) {
    return {
      logStreamName: `run/${variables.runId}${
        variables.stream === 'ENGINE'
          ? '/engine'
          : variables.stream === 'TASK'
            ? `/task/${variables.taskId ?? ''}`
            : ''
      }`,
      events: [
        {
          timestamp: Date.now(),
          message: '[mock mode] Live CloudWatch logs are available against a real backend.',
        },
      ],
      nextToken: null,
    };
  }
  const data = await runQuery<GetRunLogsData>(GET_RUN_LOGS, variables);
  return (
    data.getRunLogs ?? {
      logStreamName: '',
      events: [],
      nextToken: null,
    }
  );
}

/**
 * Fetches a best-effort excerpt of the most relevant error lines from a
 * run/task's CloudWatch log stream (Option B: HealthOmics' own `statusMessage`
 * is frequently just boilerplate telling the operator to go read the logs,
 * with no actual diagnosis). `found: false` means no error-shaped line was
 * located — never a fabricated excerpt. In local mock mode returns
 * `found: false` (no backend).
 */
export async function getErrorExcerpt(variables: {
  runId: string;
  stream: LogStream;
  taskId?: string;
}): Promise<ErrorExcerpt> {
  if (isLocalMockMode()) {
    return { found: false, lines: [], truncated: false };
  }
  const data = await runQuery<GetErrorExcerptData>(GET_ERROR_EXCERPT, variables);
  return data.getErrorExcerpt ?? { found: false, lines: [], truncated: false };
}

/**
 * Fetches measured resource-utilization metrics for a run over a window
 * (Cognito-authed, backed by a Lambda data source that signs a PromQL query
 * against CloudWatch). Defaults to the CORE (CPU+MEMORY) families when
 * `families` is omitted.
 *
 * An empty `series` array means metrics are unavailable (e.g. the run started
 * before the run-role emission permission was granted); a non-null `error`
 * means the query itself failed. The two are never conflated (Req 10.3, 10.4).
 * In local mock mode returns an empty-series success (no backend), so the UI
 * honestly shows the unavailable state rather than fabricating data.
 */
export async function getRunMetrics(variables: {
  runId: string;
  startTime?: string;
  endTime?: string;
  stepSeconds?: number;
  families?: MetricFamily[];
}): Promise<RunMetrics> {
  if (isLocalMockMode()) {
    return { runId: variables.runId, window: null, series: [], error: null };
  }
  const data = await runQuery<GetRunMetricsData>(GET_RUN_METRICS, variables);
  return data.getRunMetrics;
}

/**
 * Fetches an estimated per-run cost breakdown (Cognito-authed, backed by a
 * Lambda data source that prices measured task runtime against the published
 * AWS Price List). This is a list-price ESTIMATE, never the actual billed
 * amount, and is never persisted.
 *
 * A `null` `error` with `available: false` line items (or an empty `lineItems`
 * with `total: null`) is the honest "unavailable" state; a non-null `error`
 * means the query itself failed. The two are never conflated. In local mock
 * mode returns an honest unavailable estimate (no backend), so the UI shows the
 * unavailable state rather than fabricating a cost.
 */
export async function getRunCostEstimate(variables: {
  runId: string;
}): Promise<RunCostEstimate> {
  if (isLocalMockMode()) {
    return {
      runId: variables.runId,
      lineItems: [],
      total: null,
      currency: null,
      effectiveDate: null,
      partial: false,
      error: null,
    };
  }
  const data = await runQuery<GetRunCostEstimateData>(
    GET_RUN_COST_ESTIMATE,
    variables,
  );
  return data.getRunCostEstimate;
}

/**
 * Enumerate the workflow+version groups with runs in a window (report pickers).
 * In local mock mode, derives groups from the sample runs so the Reports view
 * is browsable with no backend.
 */
export async function listWorkflowGroups(variables: {
  start: string;
  end: string;
}): Promise<WorkflowGroup[]> {
  if (isLocalMockMode()) {
    return MOCK_WORKFLOW_GROUPS;
  }
  const data = await runQuery<ListWorkflowGroupsData>(
    LIST_WORKFLOW_GROUPS,
    variables,
  );
  return data.listWorkflowGroups;
}

/**
 * Fetch the aggregated report for one workflow+version over a window. Returns
 * null when the group has no runs in the window. In local mock mode, returns a
 * small deterministic sample report (honest availability preserved).
 */
export async function getWorkflowReport(variables: {
  workflowName: string;
  versionName: string;
  start: string;
  end: string;
}): Promise<WorkflowReport | null> {
  if (isLocalMockMode()) {
    return mockWorkflowReport(variables.workflowName, variables.versionName, variables.start, variables.end);
  }
  const data = await runQuery<GetWorkflowReportData>(
    GET_WORKFLOW_REPORT,
    variables,
  );
  return data.getWorkflowReport;
}

/**
 * Fetch one paginated page of per-run rows for the CSV export path (kept out of
 * the size-bounded report). In local mock mode, returns the mock report's
 * sample as a single page (no `nextToken`).
 */
export async function listWorkflowRunPoints(variables: {
  workflowName: string;
  versionName: string;
  start: string;
  end: string;
  limit?: number;
  nextToken?: string | null;
}): Promise<RunPointConnection> {
  if (isLocalMockMode()) {
    const rep = mockWorkflowReport(
      variables.workflowName,
      variables.versionName,
      variables.start,
      variables.end,
    );
    return { items: rep.sample, nextToken: null };
  }
  const data = await runQuery<ListWorkflowRunPointsData>(
    LIST_WORKFLOW_RUN_POINTS,
    variables,
  );
  return data.listWorkflowRunPoints ?? { items: [], nextToken: null };
}

// --- Long-lived subscription helpers (all subsequent changes, Req 10.4) -----

/** Handle to a live subscription; call `unsubscribe()` to tear it down. */
export interface Subscription {
  unsubscribe(): void;
}

/** Callbacks for a subscription stream. */
export interface SubscriptionHandlers<T> {
  readonly next: (value: T) => void;
  readonly error?: (error: unknown) => void;
}

/**
 * Subscribes to run updates (`onRunUpdated`). Delivers each updated run as it
 * is published; the caller applies it to the fleet in ordered position.
 */
export function onRunUpdated(
  handlers: SubscriptionHandlers<Run>,
): Subscription {
  if (isLocalMockMode()) {
    // No live backend in mock mode: return a no-op subscription so the view
    // stays on its initial data and never attempts an authenticated socket.
    return { unsubscribe: () => {} };
  }
  return runSubscription<OnRunUpdatedData>(ON_RUN_UPDATED).subscribe({
    next: ({ data }) => {
      if (data?.onRunUpdated) {
        handlers.next(data.onRunUpdated);
      }
    },
    error: (error) => handlers.error?.(error),
  });
}

/**
 * Subscribes to task updates for a single run (`onTaskUpdated(runId)`).
 * Delivers only tasks whose `runId` matches the subscribed run.
 */
export function onTaskUpdated(
  runId: string,
  handlers: SubscriptionHandlers<Task>,
): Subscription {
  if (isLocalMockMode()) {
    return { unsubscribe: () => {} };
  }
  return runSubscription<OnTaskUpdatedData>(ON_TASK_UPDATED, {
    runId,
  }).subscribe({
    next: ({ data }) => {
      if (data?.onTaskUpdated) {
        handlers.next(data.onTaskUpdated);
      }
    },
    error: (error) => handlers.error?.(error),
  });
}
