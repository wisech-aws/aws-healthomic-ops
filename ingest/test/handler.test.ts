import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBridgeEvent } from 'aws-lambda';

import {
  createHandler,
  type HandlerDependencies,
  type IngestRepository,
  type IngestEnricher,
  type IngestPublisher,
} from '../src/handler.js';
import type { RunRecord, TaskRecord } from '../src/domain/records.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import type { StaticGraph, WorkflowDefinition } from '../src/parser/types.js';

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

  it('persists then publishes a valid task event', async () => {
    const { repo, tasks } = makeRepository();
    const { publisher, publishedTasks } = makePublisher();
    const enricher = makeEnricher({
      enrichTask: async (runId, taskId) => ({
        runId,
        taskId,
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:01:00.000Z',
        cpus: 4,
        memory: 8,
      }),
    });
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

    const detail = {
      runId: 'run-1',
      status: TaskStatus.RUNNING,
      name: 'align',
      arn: 'arn:aws:omics:us-east-1:123456789012:run/run-1/task/8888888',
    };
    await createHandler(deps)(taskEvent(detail));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      runId: 'run-1',
      taskId: '8888888',
      status: TaskStatus.RUNNING,
      name: 'align',
      cpus: 4,
      memory: 8,
      updatedAt: '2024-01-02T03:04:05.678Z',
    });
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
    const deps: HandlerDependencies = { repository: repo, enricher, publisher };

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
