import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBridgeEvent } from 'aws-lambda';

import {
  createHandler,
  GRAPH_FAILURE_RETRY_WINDOW_MS,
  parseEnrichmentMode,
  type HandlerDependencies,
  type IngestRepository,
  type IngestEnricher,
  type IngestPublisher,
} from '../src/handler.js';
import type { RunRecord, TaskRecord } from '../src/domain/records.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import type { StaticGraph, WorkflowDefinition } from '../src/parser/types.js';
import { DynamoRepository } from '../src/repository.js';
import { InMemoryDocClient } from './helpers/inMemoryDocClient.js';
import { runEvents, taskLifecycle, type OmicsEvent } from './fixtures/events.js';

/**
 * Handler unit tests (task 8.2 / 8.5). They exercise the wired pipeline —
 * classify/map → enrich → resolve/cache static graph → persist → publish —
 * through injected fakes so no AWS clients are needed (Req 13.1). Each fake
 * records its calls so the tests can assert ordering and the failure-isolation
 * guarantee that a downstream failure never discards persisted state
 * (Req 4.1, 4.2).
 */

const REGION = 'us-east-1';

/** A recording repository fake. */
function makeRepository(
  overrides: Partial<IngestRepository> = {},
): {
  repo: IngestRepository;
  runs: RunRecord[];
  tasks: TaskRecord[];
  graphGets: string[];
  graphPuts: Array<{ workflowId: string; graph: StaticGraph }>;
  graphFailures: Array<{ workflowId: string; reason: string }>;
} {
  const runs: RunRecord[] = [];
  const tasks: TaskRecord[] = [];
  const graphGets: string[] = [];
  const graphPuts: Array<{ workflowId: string; graph: StaticGraph }> = [];
  const graphFailures: Array<{ workflowId: string; reason: string }> = [];

  const repo: IngestRepository = {
    upsertRun: async (run) => {
      runs.push(run);
      return { outcome: 'written' };
    },
    upsertTask: async (task) => {
      tasks.push(task);
      return { outcome: 'written' };
    },
    getStaticGraph: async (workflowId, _workflowVersionName) => {
      graphGets.push(workflowId);
      return null;
    },
    putStaticGraph: async (workflowId, _workflowVersionName, graph) => {
      graphPuts.push({ workflowId, graph });
    },
    recordGraphFailure: async (workflowId, _workflowVersionName, reason) => {
      graphFailures.push({ workflowId, reason });
    },
    ...overrides,
  };

  return { repo, runs, tasks, graphGets, graphPuts, graphFailures };
}

/** An enricher fake returning empty results by default. */
function makeEnricher(overrides: Partial<IngestEnricher> = {}): IngestEnricher {
  return {
    enrichRun: async () => ({}),
    enrichTask: async () => ({}),
    getWorkflowDefinition: async () => null,
    ...overrides,
  };
}

/** A publisher fake that records what was published and returns `published`. */
function makePublisher(
  overrides: Partial<IngestPublisher> = {},
): {
  publisher: IngestPublisher;
  publishedRuns: RunRecord[];
  publishedTasks: TaskRecord[];
} {
  const publishedRuns: RunRecord[] = [];
  const publishedTasks: TaskRecord[] = [];
  const publisher: IngestPublisher = {
    publishRunUpdate: async (run) => {
      publishedRuns.push(run);
      return { outcome: 'published' };
    },
    publishTaskUpdate: async (task) => {
      publishedTasks.push(task);
      return { outcome: 'published' };
    },
    ...overrides,
  };
  return { publisher, publishedRuns, publishedTasks };
}

function runEvent(
  detail: Record<string, unknown>,
  time = '2024-01-02T03:04:05.678Z',
): EventBridgeEvent<string, unknown> {
  return {
    version: '0',
    id: 'evt-run',
    'detail-type': 'Run Status Change',
    source: 'aws.omics',
    account: '123456789012',
    time,
    region: REGION,
    resources: [],
    detail,
  };
}

function taskEvent(
  detail: Record<string, unknown>,
  time = '2024-01-02T03:04:05.678Z',
): EventBridgeEvent<string, unknown> {
  return {
    version: '0',
    id: 'evt-task',
    'detail-type': 'Task Status Change',
    source: 'aws.omics',
    account: '123456789012',
    time,
    region: REGION,
    resources: [],
    detail,
  };
}

/** A fully-populated run event `detail` so no enrichment is triggered. */
function fullRunDetail() {
  return {
    runId: 'run-1',
    status: RunStatus.RUNNING,
    runName: 'my-run',
    workflowId: 'wf-1',
    workflowName: 'my-workflow',
  };
}

describe('ingest handler pipeline', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('persists then publishes a valid run event', async () => {
    const { repo, runs } = makeRepository();
    const { publisher, publishedRuns } = makePublisher();
    const enricher = makeEnricher({
      // Fill the missing render fields (createdAt/startedAt) so enrichment merges
      // without changing the event-sourced values.
      enrichRun: async () => ({
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:01:00.000Z',
      }),
    });
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    await createHandler(deps)(runEvent(fullRunDetail()));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: 'run-1',
      status: RunStatus.RUNNING,
      name: 'my-run',
      workflowId: 'wf-1',
      updatedAt: '2024-01-02T03:04:05.678Z',
    });
    // Event wins on conflict; enrichment fills the gaps (Req 2.4).
    expect(runs[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(publishedRuns).toHaveLength(1);
    expect(publishedRuns[0].runId).toBe('run-1');
  });

  it('persists then publishes a RUNNING task event WITHOUT enriching (status + approx startedAt)', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher, publishedTasks } = makePublisher();
    let enrichCalls = 0;
    const enricher = makeEnricher({
      enrichTask: async (runId, taskId) => {
        enrichCalls += 1;
        return { runId, taskId, cpus: 4, memory: 8 };
      },
    });
    const deps: HandlerDependencies = {
      repository: repo,
      enricher,
      publisher,
      // Legacy behavior, kept as the `api` rollback mode.
      enrichmentMode: 'api',
    };

    const detail = {
      runId: 'run-1',
      status: TaskStatus.RUNNING,
      name: 'align',
      arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/8888888',
    };
    await createHandler(deps)(taskEvent(detail));

    // Terminal-only enrichment: a RUNNING event does NOT call GetRunTask.
    expect(enrichCalls).toBe(0);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      runId: 'run-1',
      taskId: '8888888',
      status: TaskStatus.RUNNING,
      name: 'align',
      updatedAt: '2024-01-02T03:04:05.678Z',
      // Approximate startedAt derived from the event time (not from an API call).
      startedAt: '2024-01-02T03:04:05.678Z',
    });
    // No enrichment => no cpus/memory yet (they arrive at terminal).
    expect(tasks[0].cpus).toBeUndefined();
    expect(tasks[0].memory).toBeUndefined();
    expect(publishedTasks).toHaveLength(1);
    expect(publishedTasks[0].taskId).toBe('8888888');
  });

  it('always enriches on a terminal (COMPLETED) task event to capture final timing', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher } = makePublisher();
    let enrichCalls = 0;
    const enricher = makeEnricher({
      enrichTask: async (runId, taskId) => {
        enrichCalls += 1;
        return {
          runId,
          taskId,
          startedAt: '2024-01-01T00:01:00.000Z',
          stoppedAt: '2024-01-01T00:09:00.000Z',
          cpus: 4,
          memory: 8,
        };
      },
    });
    const deps: HandlerDependencies = {
      repository: repo,
      enricher,
      publisher,
      // Legacy behavior, kept as the `api` rollback mode.
      enrichmentMode: 'api',
    };

    // A COMPLETED task event: even though the event carries status/name, the
    // handler must still enrich to capture the final startedAt/stoppedAt.
    const detail = {
      runId: 'run-1',
      status: TaskStatus.COMPLETED,
      name: 'align',
      arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/8888888',
    };
    await createHandler(deps)(taskEvent(detail));

    expect(enrichCalls).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: '8888888',
      status: TaskStatus.COMPLETED,
      startedAt: '2024-01-01T00:01:00.000Z',
      stoppedAt: '2024-01-01T00:09:00.000Z',
    });
  });

  it('THROWS (for EventBridge retry/DLQ) on a terminal task whose enrichment is bare — never persists a status-only task', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher, publishedTasks } = makePublisher();
    // Enrichment fails/throttles => returns just {runId} (no timing).
    const enricher = makeEnricher({
      enrichTask: async (runId) => ({ runId }),
    });
    const deps: HandlerDependencies = {
      repository: repo,
      enricher,
      publisher,
      // Legacy behavior, kept as the `api` rollback mode.
      enrichmentMode: 'api',
    };

    const detail = {
      runId: 'run-1',
      status: TaskStatus.COMPLETED,
      name: 'align',
      arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/8888888',
    };

    // The handler must throw so EventBridge retries and ultimately DLQs the
    // event, rather than committing a bare (timing-less) terminal task.
    await expect(createHandler(deps)(taskEvent(detail))).rejects.toThrow(
      /enrichment incomplete for terminal task/i,
    );
    // Nothing persisted or published — the event will be retried intact.
    expect(tasks).toHaveLength(0);
    expect(publishedTasks).toHaveLength(0);
  });

  it('does NOT throw for a non-terminal (RUNNING) task with no timing — persists best-effort', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher } = makePublisher();
    // A RUNNING task legitimately may have no startedAt yet; enrichment returns
    // just {runId}. This must persist best-effort (status only), not throw.
    const enricher = makeEnricher({ enrichTask: async (runId) => ({ runId }) });
    const deps: HandlerDependencies = {
      repository: repo,
      enricher,
      publisher,
      // Legacy behavior, kept as the `api` rollback mode.
      enrichmentMode: 'api',
    };

    const detail = {
      runId: 'run-1',
      status: TaskStatus.RUNNING,
      arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/7777777',
    };
    await expect(createHandler(deps)(taskEvent(detail))).resolves.toBeUndefined();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: '7777777', status: TaskStatus.RUNNING });
  });

  // --- Selective enrichment: only RUNNING + terminal call GetRunTask ---------
  // The task event carries only status + identifiers; GetRunTask is the sole
  // source of name/cpus/memory/timing. Those fields only become available at
  // RUNNING (name/cpus/memory/startedAt) and at terminal (stoppedAt), so the
  // intermediate transitions PENDING/STARTING/STOPPING must NOT enrich — that
  // is the change that removes the per-batch API amplification.

  it.each([TaskStatus.PENDING, TaskStatus.STARTING, TaskStatus.STOPPING])(
    'does NOT call GetRunTask for a %s task event (cheap status-only update)',
    async (status) => {
      const { repo, tasks } = makeRepository();
      const { publisher, publishedTasks } = makePublisher();
      let enrichCalls = 0;
      const enricher = makeEnricher({
        enrichTask: async (runId, taskId) => {
          enrichCalls += 1;
          return { runId, taskId };
        },
      });
      const deps: HandlerDependencies = { repository: repo, enricher, publisher };

      const detail = {
        runId: 'run-1',
        status,
        arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/5555555',
      };
      await createHandler(deps)(taskEvent(detail));

      // No enrichment, but the status IS persisted and published.
      expect(enrichCalls).toBe(0);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ taskId: '5555555', status });
      expect(publishedTasks).toHaveLength(1);
    },
  );

  it('does NOT call GetRunTask for a RUNNING task event (terminal-only enrichment) and sets an approximate startedAt', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher } = makePublisher();
    let enrichCalls = 0;
    const enricher = makeEnricher({
      enrichTask: async (runId, taskId) => {
        enrichCalls += 1;
        return { runId, taskId, name: 'align', cpus: 4, memory: 8 };
      },
    });
    const deps: HandlerDependencies = {
      repository: repo,
      enricher,
      publisher,
      // Legacy behavior, kept as the `api` rollback mode.
      enrichmentMode: 'api',
    };

    const detail = {
      runId: 'run-1',
      status: TaskStatus.RUNNING,
      name: 'align',
      arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/6666666',
    };
    await createHandler(deps)(taskEvent(detail));

    // Terminal-only policy: RUNNING is a cheap status-only write, no API call.
    expect(enrichCalls).toBe(0);
    expect(tasks[0]).toMatchObject({
      taskId: '6666666',
      status: TaskStatus.RUNNING,
      name: 'align',
      // approximate startedAt from the event time (event.time -> updatedAt)
      startedAt: '2024-01-02T03:04:05.678Z',
    });
    // cpus/memory not available until the terminal enrichment.
    expect(tasks[0].cpus).toBeUndefined();
  });

  it.each([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED])(
    'DOES call GetRunTask for a terminal %s task event (captures final timing)',
    async (status) => {
      const { repo } = makeRepository();
      const { publisher } = makePublisher();
      let enrichCalls = 0;
      const enricher = makeEnricher({
        enrichTask: async (runId, taskId) => {
          enrichCalls += 1;
          return {
            runId,
            taskId,
            startedAt: '2024-01-01T00:01:00.000Z',
            stoppedAt: '2024-01-01T00:09:00.000Z',
          };
        },
      });
      const deps: HandlerDependencies = { repository: repo, enricher, publisher };
      const detail = {
        runId: 'run-1',
        status,
        arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/4444444',
      };
      await createHandler(deps)(taskEvent(detail));
      expect(enrichCalls).toBe(1);
    },
  );

  it('RUNNING writes an approximate startedAt (no enrich); the terminal write carries the authoritative startTime', async () => {
    // RUNNING sets an approximate startedAt from event time (no enrich); the
    // later terminal event enriches and writes the authoritative timing. The
    // repository's field-merge (covered in repository.test.ts) then lets the
    // terminal value win; here we assert each WRITE carries the right values.
    const { repo, tasks } = makeRepository();
    const { publisher } = makePublisher();
    let enrichCalls = 0;
    const enricher = makeEnricher({
      enrichTask: async (runId, taskId) => {
        enrichCalls += 1;
        return {
          runId,
          taskId,
          name: 'align',
          startedAt: '2024-01-01T00:01:00.000Z', // authoritative
          stoppedAt: '2024-01-01T00:09:00.000Z',
          cpus: 4,
          memory: 8,
        };
      },
    });
    const deps: HandlerDependencies = {
      repository: repo,
      enricher,
      publisher,
      // Legacy behavior, kept as the `api` rollback mode.
      enrichmentMode: 'api',
    };
    const arn = 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/5252525';

    // 1) RUNNING (no enrich) — approximate startedAt from event time.
    await createHandler(deps)(
      taskEvent({ runId: 'run-1', status: TaskStatus.RUNNING, name: 'align', arn }, '2024-01-01T00:01:30.000Z'),
    );
    // 2) COMPLETED (enriches) — authoritative timing.
    await createHandler(deps)(
      taskEvent({ runId: 'run-1', status: TaskStatus.COMPLETED, name: 'align', arn }, '2024-01-01T00:09:05.000Z'),
    );

    expect(enrichCalls).toBe(1); // only the terminal event enriched
    const runningWrite = tasks[0];
    const terminalWrite = tasks[1];
    expect(runningWrite).toMatchObject({
      status: TaskStatus.RUNNING,
      startedAt: '2024-01-01T00:01:30.000Z', // approximate (event time)
    });
    expect(runningWrite.cpus).toBeUndefined();
    expect(terminalWrite).toMatchObject({
      status: TaskStatus.COMPLETED,
      startedAt: '2024-01-01T00:01:00.000Z', // authoritative overwrites approx
      stoppedAt: '2024-01-01T00:09:00.000Z',
      cpus: 4,
    });
  });

  it('ignores a malformed (unknown detail-type) event without persisting or publishing', async () => {
    const { repo, runs, tasks } = makeRepository();
    const { publisher, publishedRuns, publishedTasks } = makePublisher();
    const enrichRun = vi.fn(async () => ({}));
    const enricher = makeEnricher({ enrichRun });
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    const malformed: EventBridgeEvent<string, unknown> = {
      version: '0',
      id: 'evt-bad',
      'detail-type': 'Something Else',
      source: 'aws.omics',
      account: '123456789012',
      time: '2024-01-02T03:04:05.678Z',
      region: REGION,
      resources: [],
      detail: {},
    };

    await expect(createHandler(deps)(malformed)).resolves.toBeUndefined();

    expect(runs).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect(publishedRuns).toHaveLength(0);
    expect(publishedTasks).toHaveLength(0);
    expect(enrichRun).not.toHaveBeenCalled();
  });

  it('reuses a cached static graph and never re-fetches the definition', async () => {
    const cached: StaticGraph = {
      workflowId: 'wf-1',
      nodes: [{ id: 'a', name: 'a' }],
      edges: [],
      fidelity: 'exact',
    };
    const { repo, graphPuts, graphFailures } = makeRepository({
      getStaticGraph: async () => cached,
    });
    const { publisher } = makePublisher();
    const getWorkflowDefinition = vi.fn(
      async (): Promise<WorkflowDefinition | null> => null,
    );
    const enricher = makeEnricher({ getWorkflowDefinition });
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    await createHandler(deps)(runEvent(fullRunDetail()));

    // Cache hit: no fetch, no put, no failure recorded (Req 6.9, 6.13).
    expect(getWorkflowDefinition).not.toHaveBeenCalled();
    expect(graphPuts).toHaveLength(0);
    expect(graphFailures).toHaveLength(0);
  });

  it('fetches, parses, and caches the static graph on first sighting', async () => {
    const { repo, graphPuts } = makeRepository();
    const { publisher } = makePublisher();
    const definition: WorkflowDefinition = {
      workflowId: 'wf-1',
      language: 'WDL',
      files: {
        'main.wdl': [
          'workflow w {',
          '  call fastqc',
          '  call align { input: reads = fastqc.trimmed }',
          '}',
        ].join('\n'),
      },
      mainPath: 'main.wdl',
    };
    const enricher = makeEnricher({
      getWorkflowDefinition: async () => definition,
    });
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    await createHandler(deps)(runEvent(fullRunDetail()));

    expect(graphPuts).toHaveLength(1);
    expect(graphPuts[0].workflowId).toBe('wf-1');
    expect(graphPuts[0].graph.nodes.map((n) => n.name).sort()).toEqual([
      'align',
      'fastqc',
    ]);
  });

  it('records a graph failure when GetWorkflow fails, without discarding the persisted run', async () => {
    const { repo, runs, graphFailures } = makeRepository();
    const { publisher, publishedRuns } = makePublisher();
    const getWorkflowDefinition = vi.fn(
      async (): Promise<WorkflowDefinition | null> => null,
    );
    const enricher = makeEnricher({ getWorkflowDefinition });
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    await createHandler(deps)(runEvent(fullRunDetail()));

    // GetWorkflow failure => failure recorded, prior state preserved (Req 6.2, 7.1).
    expect(getWorkflowDefinition).toHaveBeenCalledOnce();
    expect(graphFailures).toHaveLength(1);
    expect(graphFailures[0].workflowId).toBe('wf-1');
    // The run was still persisted and published (Req 4.1, 4.2).
    expect(runs).toHaveLength(1);
    expect(publishedRuns).toHaveLength(1);
  });

  it('records a graph failure when the definition cannot be parsed', async () => {
    const { repo, graphFailures, graphPuts } = makeRepository();
    const { publisher } = makePublisher();
    const enricher = makeEnricher({
      // No `call` statements => the WDL parser rejects it (ParseError).
      getWorkflowDefinition: async () => ({
        workflowId: 'wf-1',
        language: 'WDL',
        files: { 'main.wdl': 'workflow w { }' },
        mainPath: 'main.wdl',
      }),
    });
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    await createHandler(deps)(runEvent(fullRunDetail()));

    expect(graphPuts).toHaveLength(0);
    expect(graphFailures).toHaveLength(1);
    expect(graphFailures[0].reason).toMatch(/parse failed/i);
  });

  it('does not discard persisted state when publish fails', async () => {
    const { repo, runs } = makeRepository();
    const enricher = makeEnricher({
      enrichRun: async () => ({
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:01:00.000Z',
      }),
    });
    const publishRunUpdate = vi.fn(async () => ({ outcome: 'failed' }));
    const publisher: IngestPublisher = {
      publishRunUpdate,
      publishTaskUpdate: async () => ({ outcome: 'published' }),
    };
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    // A failed publish returns a result (never throws); the handler resolves.
    await expect(
      createHandler(deps)(runEvent(fullRunDetail())),
    ).resolves.toBeUndefined();

    // The run remains persisted despite the publish failure (Req 4.8).
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('run-1');
    expect(publishRunUpdate).toHaveBeenCalledOnce();
  });
});

describe('static-graph failure cache (F1)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const NOW = Date.parse('2026-11-03T23:00:00.000Z');

  function depsWithEntry(entry: Awaited<ReturnType<NonNullable<IngestRepository['getGraphCacheEntry']>>>) {
    const { repo, graphFailures } = makeRepository({
      getGraphCacheEntry: async () => entry,
    });
    const getWorkflowDefinition = vi.fn(
      async (): Promise<WorkflowDefinition | null> => null,
    );
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ getWorkflowDefinition }),
      publisher: makePublisher().publisher,
      now: () => NOW,
    };
    return { deps, getWorkflowDefinition, graphFailures };
  }

  it('is a one-hour window', () => {
    expect(GRAPH_FAILURE_RETRY_WINDOW_MS).toBe(3_600_000);
  });

  it('treats a failure marker recorded 10 minutes ago as cached (no GetWorkflow)', async () => {
    const { deps, getWorkflowDefinition, graphFailures } = depsWithEntry({
      graph: null,
      failureReason: 'parse failed: graph contains a cycle',
      updatedAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    await createHandler(deps)(runEvent(fullRunDetail()));
    expect(getWorkflowDefinition).not.toHaveBeenCalled();
    expect(graphFailures).toHaveLength(0);
  });

  it('retries once the failure marker is older than the window (2 hours)', async () => {
    const { deps, getWorkflowDefinition, graphFailures } = depsWithEntry({
      graph: null,
      failureReason: 'parse failed: graph contains a cycle',
      updatedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    });
    await createHandler(deps)(runEvent(fullRunDetail()));
    expect(getWorkflowDefinition).toHaveBeenCalledOnce();
    expect(graphFailures).toHaveLength(1);
  });

  it('treats a stored graph that also carries a failure reason as cached', async () => {
    const { deps, getWorkflowDefinition } = depsWithEntry({
      graph: { workflowId: 'wf-1', nodes: [{ id: 'a', name: 'a' }], edges: [], fidelity: 'exact' },
      failureReason: 'older failure',
      updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(),
    });
    await createHandler(deps)(runEvent(fullRunDetail()));
    expect(getWorkflowDefinition).not.toHaveBeenCalled();
  });

  it('fetches when there is no cache entry at all', async () => {
    const { deps, getWorkflowDefinition } = depsWithEntry(null);
    await createHandler(deps)(runEvent(fullRunDetail()));
    expect(getWorkflowDefinition).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Event-driven enrichment (EVENT_ENRICHMENT_MODE), using real captured events
// from run 8508632 (test/fixtures/run-8508632-subset.jsonl).
// ---------------------------------------------------------------------------

/** Task 9303953 (FQ_LINT WT_REP2): PENDING, STARTING, RUNNING, COMPLETED. */
const LIFECYCLE_TASK = '9303953';
const TASK_NAME = 'NFCORE_RNASEQ:RNASEQ:FASTQ_QC_TRIM_FILTER_SETSTRANDEDNESS:FQ_LINT (WT_REP2)';
const TASK_CREATED = '2026-11-03T22:41:30.523Z';
const TASK_STARTED = '2026-11-03T22:52:31.275Z';
const TASK_STOPPED = '2026-11-03T22:52:51.913Z';

function withDetail(event: OmicsEvent, patch: Record<string, unknown>, drop: string[] = []): OmicsEvent {
  const detail: Record<string, unknown> = { ...event.detail, ...patch };
  for (const key of drop) delete detail[key];
  return { ...event, detail };
}

/** Parse every JSON console.log line with the given `msg`. */
function jsonLogs(spy: ReturnType<typeof vi.spyOn>, msg: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of spy.mock.calls) {
    const first = call[0];
    if (typeof first !== 'string' || !first.startsWith('{')) continue;
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (parsed.msg === msg) out.push(parsed);
  }
  return out;
}

describe('event-driven task enrichment', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('event mode: a full COMPLETED lifecycle makes ZERO HealthOmics calls and publishes every event with its fields', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher, publishedTasks } = makePublisher();
    const enrichTask = vi.fn(async () => ({}));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichTask }),
      publisher,
      enrichmentMode: 'event',
    };
    const handler = createHandler(deps);
    for (const event of taskLifecycle(LIFECYCLE_TASK)) {
      await handler(event);
    }

    expect(enrichTask).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(4);
    expect(publishedTasks.map((t) => t.status)).toEqual([
      TaskStatus.PENDING,
      TaskStatus.STARTING,
      TaskStatus.RUNNING,
      TaskStatus.COMPLETED,
    ]);
    for (const published of publishedTasks) {
      expect(published).toMatchObject({
        runId: '8508632',
        taskId: LIFECYCLE_TASK,
        name: TASK_NAME,
        cpus: 2,
        memory: 12,
        createdAt: TASK_CREATED,
      });
    }
    const [pending, , running, completed] = publishedTasks;
    expect(pending.instanceType).toBeUndefined();
    expect(pending.startedAt).toBeUndefined();
    // RUNNING uses the event's exact startTime, not the (whole-second) event.time.
    expect(running).toMatchObject({ instanceType: 'omics.r.large', startedAt: TASK_STARTED });
    expect(running.startedAt).not.toBe('2026-11-03T22:52:31.000Z');
    expect(completed).toMatchObject({
      instanceType: 'omics.r.large',
      startedAt: TASK_STARTED,
      stoppedAt: TASK_STOPPED,
    });
  });

  it('defaults to event mode when enrichmentMode is not set', async () => {
    const { repo } = makeRepository();
    const enrichTask = vi.fn(async () => ({}));
    const handler = createHandler({
      repository: repo,
      enricher: makeEnricher({ enrichTask }),
      publisher: makePublisher().publisher,
    });
    for (const event of taskLifecycle(LIFECYCLE_TASK)) {
      await handler(event);
    }
    expect(enrichTask).not.toHaveBeenCalled();
  });

  it('a FAILED task event makes exactly one GetRunTask and persists statusMessage/failureReason', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher, publishedTasks } = makePublisher();
    const enrichTask = vi.fn(async (runId: string, taskId: string) => ({
      runId,
      taskId,
      status: TaskStatus.FAILED,
      startedAt: TASK_STARTED,
      stoppedAt: TASK_STOPPED,
      statusMessage: 'Task failed: exit code 1',
      failureReason: 'RUN_TASK_FAILED',
    }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichTask }),
      publisher,
      enrichmentMode: 'event',
    };
    const completed = taskLifecycle(LIFECYCLE_TASK)[3];
    await createHandler(deps)(withDetail(completed, { status: 'FAILED' }));

    expect(enrichTask).toHaveBeenCalledOnce();
    expect(tasks[0]).toMatchObject({
      status: TaskStatus.FAILED,
      name: TASK_NAME,
      statusMessage: 'Task failed: exit code 1',
      failureReason: 'RUN_TASK_FAILED',
      stoppedAt: TASK_STOPPED,
    });
    expect(publishedTasks[0].failureReason).toBe('RUN_TASK_FAILED');
  });

  it('a terminal event missing startTime/stopTime falls back to one GetRunTask', async () => {
    const { repo, tasks } = makeRepository();
    const enrichTask = vi.fn(async (runId: string, taskId: string) => ({
      runId,
      taskId,
      startedAt: TASK_STARTED,
      stoppedAt: TASK_STOPPED,
    }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichTask }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'event',
    };
    const completed = taskLifecycle(LIFECYCLE_TASK)[3];
    await createHandler(deps)(withDetail(completed, {}, ['startTime', 'stopTime']));

    expect(enrichTask).toHaveBeenCalledOnce();
    expect(tasks[0]).toMatchObject({ startedAt: TASK_STARTED, stoppedAt: TASK_STOPPED });
  });

  it('a terminal event missing taskName falls back to one GetRunTask', async () => {
    const { repo, tasks } = makeRepository();
    const enrichTask = vi.fn(async (runId: string, taskId: string) => ({ runId, taskId, name: 'from-api' }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichTask }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'event',
    };
    const completed = taskLifecycle(LIFECYCLE_TASK)[3];
    await createHandler(deps)(withDetail(completed, {}, ['taskName']));
    expect(enrichTask).toHaveBeenCalledOnce();
    expect(tasks[0].name).toBe('from-api');
  });

  it('still throws when the fallback GetRunTask also lacks startedAt (bare terminal)', async () => {
    const { repo, tasks } = makeRepository();
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichTask: async (runId) => ({ runId }) }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'event',
    };
    const completed = taskLifecycle(LIFECYCLE_TASK)[3];
    await expect(
      createHandler(deps)(withDetail(completed, {}, ['startTime', 'stopTime'])),
    ).rejects.toThrow(/enrichment incomplete for terminal task/);
    expect(tasks).toHaveLength(0);
  });

  it('api mode reproduces the legacy pattern: GetRunTask at COMPLETED only, approximate RUNNING startedAt, no name', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher, publishedTasks } = makePublisher();
    const enrichTask = vi.fn(async (runId: string, taskId: string) => ({
      runId,
      taskId,
      name: TASK_NAME,
      startedAt: TASK_STARTED,
      stoppedAt: TASK_STOPPED,
      cpus: 2,
      memory: 12,
    }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichTask }),
      publisher,
      enrichmentMode: 'api',
    };
    const handler = createHandler(deps);
    for (const event of taskLifecycle(LIFECYCLE_TASK)) {
      await handler(event);
    }

    expect(enrichTask).toHaveBeenCalledOnce();
    const running = tasks[2];
    expect(running.status).toBe(TaskStatus.RUNNING);
    expect(running.startedAt).toBe('2026-11-03T22:52:31.000Z'); // event.time
    expect(running.name).toBeUndefined();
    expect(running.cpus).toBeUndefined();
    expect(tasks[0]).toEqual({
      runId: '8508632',
      taskId: LIFECYCLE_TASK,
      status: TaskStatus.PENDING,
      updatedAt: '2026-11-03T22:41:30.000Z',
    });
    expect(tasks[3]).toMatchObject({ name: TASK_NAME, startedAt: TASK_STARTED, cpus: 2 });
    expect(publishedTasks).toHaveLength(4);
  });

  it('shadow mode calls GetRunTask on terminal, emits an EMF mismatch line per field, and writes the API value', async () => {
    const { repo, tasks } = makeRepository();
    const enrichTask = vi.fn(async (runId: string, taskId: string) => ({
      runId,
      taskId,
      status: TaskStatus.COMPLETED,
      name: TASK_NAME,
      cpus: 4, // differs from the event's "2"
      memory: 12,
      instanceType: 'omics.r.large',
      createdAt: TASK_CREATED,
      startedAt: TASK_STARTED,
      stoppedAt: TASK_STOPPED,
    }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichTask }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'shadow',
    };
    const handler = createHandler(deps);
    for (const event of taskLifecycle(LIFECYCLE_TASK)) {
      await handler(event);
    }

    expect(enrichTask).toHaveBeenCalledOnce(); // terminal only
    const mismatches = jsonLogs(logSpy, 'enrichment_shadow_mismatch');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      field: 'cpus',
      eventValue: 2,
      apiValue: 4,
      EnrichmentShadowMismatch: 1,
      runId: '8508632',
      taskId: LIFECYCLE_TASK,
    });
    expect(mismatches[0]._aws).toMatchObject({
      CloudWatchMetrics: [
        {
          Namespace: 'HealthOmicsIngest',
          Dimensions: [['field']],
          Metrics: [{ Name: 'EnrichmentShadowMismatch', Unit: 'Count' }],
        },
      ],
    });
    expect(tasks[3].cpus).toBe(4); // API value written
    // Non-terminal shadow events use event values (no call).
    expect(tasks[0].cpus).toBe(2);
  });

  it('shadow mode emits no mismatch line when the API agrees with the event', async () => {
    const { repo } = makeRepository();
    const completed = taskLifecycle(LIFECYCLE_TASK)[3];
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({
        enrichTask: async (runId, taskId) => ({
          runId,
          taskId,
          name: TASK_NAME,
          cpus: 2,
          memory: 12,
          instanceType: 'omics.r.large',
          createdAt: TASK_CREATED,
          startedAt: TASK_STARTED,
          stoppedAt: TASK_STOPPED,
        }),
      }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'shadow',
    };
    await createHandler(deps)(completed);
    expect(jsonLogs(logSpy, 'enrichment_shadow_mismatch')).toHaveLength(0);
  });

  it('logs exactly one concise ingest_event line per event with the API calls made, never the payload', async () => {
    const { repo } = makeRepository();
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({
        enrichTask: async (runId, taskId) => ({ runId, taskId, startedAt: TASK_STARTED }),
      }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'event',
    };
    const handler = createHandler(deps);
    const events = taskLifecycle(LIFECYCLE_TASK);
    for (const event of events) {
      await handler(event);
    }
    await handler(withDetail(events[3], { status: 'FAILED' }));

    const lines = jsonLogs(logSpy, 'ingest_event');
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.status)).toEqual(['PENDING', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED']);
    for (const line of lines.slice(0, 4)) {
      expect(line).toMatchObject({
        type: 'TASK',
        runId: '8508632',
        taskId: LIFECYCLE_TASK,
        mode: 'event',
        apiCalls: { GetRun: 0, GetRunTask: 0, GetWorkflow: 0 },
        write: 'written',
        publish: 'published',
      });
    }
    expect(lines[4].apiCalls).toEqual({ GetRun: 0, GetRunTask: 1, GetWorkflow: 0 });
    for (const call of logSpy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain('"detail"');
    }
  });

  it('logs an unknown event concisely without its payload', async () => {
    const { repo } = makeRepository();
    const handler = createHandler({
      repository: repo,
      enricher: makeEnricher(),
      publisher: makePublisher().publisher,
    });
    await handler({ ...runEvents()[0], 'detail-type': 'Something Else' });
    const lines = jsonLogs(logSpy, 'ingest_event');
    expect(lines).toEqual([
      expect.objectContaining({ type: 'UNKNOWN', detailType: 'Something Else', source: 'aws.omics' }),
    ]);
    for (const call of logSpy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain('"detail"');
    }
  });
});

describe('event-driven run enrichment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const GETRUN = {
    createdAt: '2026-11-03T22:29:28.006Z',
    parameters: '{"input":"s3://bucket/samplesheet.csv"}',
    roleArn: 'arn:aws:iam::123456789012:role/omics',
    networkingMode: 'VPC',
    rawGetRun: '{"id":"8508632"}',
  };

  /** A repository fake whose marker reflects whether rawGetRun was written. */
  function markerRepository(initialMarker: { hasGetRun: boolean } | null = null) {
    let marker = initialMarker;
    const base = makeRepository({
      upsertRun: async (run) => {
        base.runs.push(run);
        if (run.rawGetRun !== undefined) marker = { hasGetRun: true };
        else if (marker === null) marker = { hasGetRun: false };
        return { outcome: 'written' };
      },
      getRunEnrichmentMarker: async () => marker,
    });
    return base;
  }

  it('calls GetRun only at PENDING and terminal (2 calls for 5 events) and derives startedAt from the RUNNING event time', async () => {
    const { repo, runs } = markerRepository();
    const { publisher, publishedRuns } = makePublisher();
    const enrichRun = vi.fn(async () => ({ ...GETRUN }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichRun }),
      publisher,
      enrichmentMode: 'event',
    };
    const handler = createHandler(deps);
    for (const event of runEvents()) {
      await handler(event);
    }

    expect(enrichRun).toHaveBeenCalledTimes(2);
    expect(runs.map((r) => r.status)).toEqual([
      RunStatus.PENDING,
      RunStatus.STARTING,
      RunStatus.RUNNING,
      RunStatus.STOPPING,
      RunStatus.COMPLETED,
    ]);
    expect(runs[0]).toMatchObject({ createdAt: GETRUN.createdAt, workflowVersionName: 'v2-wave-fix' });
    expect(runs[1].rawGetRun).toBeUndefined(); // STARTING used event data only
    expect(runs[2].startedAt).toBe('2026-11-03T22:40:02.000Z');
    expect(runs[2].outputUri).toContain('/8508632');
    expect(publishedRuns).toHaveLength(5);
  });

  it('uses the PENDING event time as createdAt when GetRun returned nothing', async () => {
    const { repo, runs } = markerRepository();
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichRun: async () => ({}) }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'event',
    };
    await createHandler(deps)(runEvents()[0]);
    expect(runs[0].createdAt).toBe('2026-11-03T22:29:28.000Z');
  });

  it('falls back to GetRun on STARTING when the stored run lacks rawGetRun', async () => {
    const { repo } = markerRepository({ hasGetRun: false });
    const enrichRun = vi.fn(async () => ({ ...GETRUN }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichRun }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'event',
    };
    await createHandler(deps)(runEvents()[1]);
    expect(enrichRun).toHaveBeenCalledOnce();
  });

  it('falls back to GetRun on RUNNING when there is no stored run (missed PENDING)', async () => {
    const { repo } = markerRepository(null);
    const enrichRun = vi.fn(async () => ({ ...GETRUN }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichRun }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'event',
    };
    await createHandler(deps)(runEvents()[2]);
    expect(enrichRun).toHaveBeenCalledOnce();
  });

  it('api mode calls GetRun on every run event', async () => {
    const { repo } = markerRepository();
    const enrichRun = vi.fn(async () => ({ ...GETRUN }));
    const deps: HandlerDependencies = {
      repository: repo,
      enricher: makeEnricher({ enrichRun }),
      publisher: makePublisher().publisher,
      enrichmentMode: 'api',
    };
    const handler = createHandler(deps);
    for (const event of runEvents()) {
      await handler(event);
    }
    expect(enrichRun).toHaveBeenCalledTimes(5);
  });
});

describe('out-of-order delivery with the real repository guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  function realRepo() {
    const db = new InMemoryDocClient();
    const repository = new DynamoRepository(db.asDocClient(), 'test-table');
    return { db, repository };
  }

  it('task COMPLETED then a late RUNNING: stays COMPLETED with all fields, and the stale RUNNING is not published', async () => {
    const { db, repository } = realRepo();
    const { publisher, publishedTasks } = makePublisher();
    const enrichTask = vi.fn(async () => ({}));
    const handler = createHandler({
      repository,
      enricher: makeEnricher({ enrichTask }),
      publisher,
      enrichmentMode: 'event',
    });
    const [, , running, completed] = taskLifecycle(LIFECYCLE_TASK);
    await handler(completed);
    await handler(running);

    const stored = db.store.get(`RUN#8508632|TASK#${LIFECYCLE_TASK}`);
    expect(stored).toMatchObject({
      status: 'COMPLETED',
      name: TASK_NAME,
      instanceType: 'omics.r.large',
      startedAt: TASK_STARTED,
      stoppedAt: TASK_STOPPED,
      cpus: 2,
      memory: 12,
    });
    expect(enrichTask).not.toHaveBeenCalled();
    expect(publishedTasks.map((t) => t.status)).toEqual([TaskStatus.COMPLETED]);
  });

  it('publishes the merged stored task (cumulative fields) after a sparse event', async () => {
    const { repository } = realRepo();
    const { publisher, publishedTasks } = makePublisher();
    const handler = createHandler({
      repository,
      enricher: makeEnricher(),
      publisher,
      enrichmentMode: 'event',
    });
    const [, , running, completed] = taskLifecycle(LIFECYCLE_TASK);
    await handler(running);
    // A sparse STOPPING-like event (older schema) carrying only identity+status.
    await handler(
      withDetail(completed, { status: 'STOPPING' }, [
        'taskName', 'cpus', 'memory', 'instanceType', 'creationTime', 'startTime', 'stopTime',
      ]),
    );
    expect(publishedTasks[1]).toMatchObject({
      status: TaskStatus.STOPPING,
      name: TASK_NAME,
      cpus: 2,
      instanceType: 'omics.r.large',
      startedAt: TASK_STARTED,
    });
  });

  it('run PENDING arriving after RUNNING: status stays RUNNING, earlier config unchanged, no publish', async () => {
    const { db, repository } = realRepo();
    const { publisher, publishedRuns } = makePublisher();
    let call = 0;
    const enrichRun = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { parameters: '{"v":"first"}', rawGetRun: '{"n":1}', createdAt: '2026-11-03T22:29:28.006Z' }
        : { parameters: '{"v":"second"}', rawGetRun: '{"n":2}' };
    });
    const handler = createHandler({
      repository,
      enricher: makeEnricher({ enrichRun }),
      publisher,
      enrichmentMode: 'event',
    });
    const [pending, , running] = runEvents();
    await handler(running); // no stored run -> fallback GetRun
    await handler(pending); // late

    const stored = db.store.get('RUN#8508632|RUN#8508632');
    expect(stored).toMatchObject({
      status: 'RUNNING',
      parameters: '{"v":"first"}',
      rawGetRun: '{"n":1}',
      startedAt: '2026-11-03T22:40:02.000Z',
    });
    expect(publishedRuns.map((r) => r.status)).toEqual([RunStatus.RUNNING]);
    // The published run is the merged stored item and carries the GetRun data.
    expect(publishedRuns[0].parameters).toBe('{"v":"first"}');
  });
});

describe('parseEnrichmentMode', () => {
  it('defaults to event and accepts the three modes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseEnrichmentMode(undefined)).toBe('event');
    expect(parseEnrichmentMode('')).toBe('event');
    expect(parseEnrichmentMode('shadow')).toBe('shadow');
    expect(parseEnrichmentMode('API')).toBe('api');
    expect(parseEnrichmentMode('event')).toBe('event');
    expect(parseEnrichmentMode('bogus')).toBe('event');
  });
});
