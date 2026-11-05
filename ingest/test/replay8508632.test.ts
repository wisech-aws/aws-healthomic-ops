/**
 * Replay of real run 8508632 (nf-core-rnaseq v2-wave-fix) through the ingest
 * handler with mocked AWS clients, bounding the HealthOmics calls per mode.
 *
 * Wiring: the real `DynamoRepository` over the condition-evaluating in-memory
 * DynamoDB double, the real `enrichRun` / `enrichTask` over a call-counting fake
 * `OmicsClient` (no rate limiting), a counting `getWorkflowDefinition` fake that
 * returns no definition (so a graph failure marker is recorded), and a recording
 * publisher. The fixture holds all 5 run events and every event of 12 of the
 * run's 207 tasks, in arrival order.
 *
 * Expected HealthOmics calls:
 *   mode    GetRunTask  GetRun  GetWorkflow   subset   full run (207 tasks)
 *   event        0         2         1           3        3
 *   api         12         5         1          18      213 (217 before the
 *                                                         graph-failure cache)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OmicsClient } from '@aws-sdk/client-omics';

import {
  createHandler,
  type EnrichmentMode,
  type IngestRepository,
} from '../src/handler.js';
import { enrichRun, enrichTask } from '../src/enrichment/tasks.js';
import { DynamoRepository } from '../src/repository.js';
import type { RunRecord, TaskRecord } from '../src/domain/records.js';
import type { WorkflowDefinition } from '../src/parser/types.js';
import { InMemoryDocClient } from './helpers/inMemoryDocClient.js';
import {
  REPLAY_RUN_ID,
  SAME_SECOND_TASK_ID,
  loadReplay,
  taskEvents,
  taskIdOf,
} from './fixtures/events.js';

const NO_PACING = {
  timeoutMs: 1_000,
  maxAttempts: 1,
  sleep: async () => {},
  logger: () => undefined,
  rateLimiter: { acquire: async () => {} },
};

const RUN_CREATED = '2026-11-03T22:29:28.006Z';
const RUN_STARTED = '2026-11-03T22:40:02.000Z';
const RUN_STOPPED = '2026-11-03T23:19:44.917Z';

/** GetRunTask responses derived from each task's COMPLETED event (numbers + Dates). */
function getRunTaskResponses(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const event of taskEvents('COMPLETED')) {
    const d = event.detail;
    out.set(taskIdOf(event), {
      taskId: taskIdOf(event),
      status: 'COMPLETED',
      name: d.taskName,
      cpus: Number(d.cpus),
      memory: Number(d.memory),
      gpus: Number(d.gpus),
      instanceType: d.instanceType,
      creationTime: new Date(String(d.creationTime)),
      startTime: new Date(String(d.startTime)),
      stopTime: new Date(String(d.stopTime)),
    });
  }
  return out;
}

async function replay(mode: EnrichmentMode) {
  const db = new InMemoryDocClient();
  const repo = new DynamoRepository(db.asDocClient(), 'replay-table');
  // The in-memory double does not model the Group_Registry ADD expression, so
  // the adapter omits upsertGroupRegistry (optional on the interface).
  const repository: IngestRepository = {
    upsertRun: (r) => repo.upsertRun(r),
    upsertTask: (t) => repo.upsertTask(t),
    getStaticGraph: (w, v) => repo.getStaticGraph(w, v),
    getGraphCacheEntry: (w, v) => repo.getGraphCacheEntry(w, v),
    getRunEnrichmentMarker: (id) => repo.getRunEnrichmentMarker(id),
    putStaticGraph: (w, v, g, l) => repo.putStaticGraph(w, v, g, l),
    recordGraphFailure: (w, v, reason) => repo.recordGraphFailure(w, v, reason),
    upsertSummary: (s) => repo.upsertSummary(s),
    listTaskItemsForRun: (id) => repo.listTaskItemsForRun(id),
  };

  const calls = { GetRun: 0, GetRunTask: 0, GetWorkflow: 0, other: 0 };
  const taskResponses = getRunTaskResponses();
  let runStatus = 'PENDING';
  const omics = {
    send: async (command: { constructor: { name: string }; input: { taskId?: string } }) => {
      switch (command.constructor.name) {
        case 'GetRunCommand': {
          calls.GetRun += 1;
          const started = ['RUNNING', 'STOPPING', 'COMPLETED'].includes(runStatus);
          return {
            id: REPLAY_RUN_ID,
            name: 'rnaseq-vpc-event-enrichment-20261103-1729',
            status: runStatus,
            workflowId: '2897933',
            workflowVersionName: 'v2-wave-fix',
            roleArn: 'arn:aws:iam::123456789012:role/omics-run',
            networkingMode: 'VPC',
            parameters: { input: 's3://example-bucket/samplesheet.csv' },
            runOutputUri: 's3://example-bucket/run-outputs/8508632',
            creationTime: new Date(RUN_CREATED),
            ...(started ? { startTime: new Date(RUN_STARTED) } : {}),
            ...(runStatus === 'COMPLETED' ? { stopTime: new Date(RUN_STOPPED) } : {}),
          };
        }
        case 'GetRunTaskCommand':
          calls.GetRunTask += 1;
          return taskResponses.get(String(command.input.taskId)) ?? {};
        default:
          calls.other += 1;
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  } as unknown as OmicsClient;

  const publishedRuns: RunRecord[] = [];
  const publishedTasks: TaskRecord[] = [];
  const handler = createHandler({
    repository,
    enricher: {
      enrichRun: (runId) => enrichRun(omics, runId, NO_PACING),
      enrichTask: (runId, taskId) => enrichTask(omics, runId, taskId, NO_PACING),
      getWorkflowDefinition: async (): Promise<WorkflowDefinition | null> => {
        calls.GetWorkflow += 1;
        return null;
      },
    },
    publisher: {
      publishRunUpdate: async (run) => {
        publishedRuns.push(run);
        return { outcome: 'published' };
      },
      publishTaskUpdate: async (task) => {
        publishedTasks.push(task);
        return { outcome: 'published' };
      },
    },
    enrichmentMode: mode,
  });

  const events = loadReplay();
  for (const event of events) {
    if (event['detail-type'] === 'Run Status Change') {
      runStatus = String(event.detail.status);
    }
    await handler(event);
  }

  const logLines = (vi.mocked(console.log).mock.calls as unknown[][])
    .map((c) => c[0])
    .filter((l): l is string => typeof l === 'string' && l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  return { db, calls, events, publishedRuns, publishedTasks, logLines };
}

describe('replay run 8508632 through the ingest handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('event mode: 3 HealthOmics calls (0 GetRunTask, 2 GetRun, 1 GetWorkflow) and fully populated tasks', async () => {
    const { db, calls, events, publishedRuns, publishedTasks, logLines } = await replay('event');

    expect(events).toHaveLength(53);
    expect(calls).toEqual({ GetRun: 2, GetRunTask: 0, GetWorkflow: 1, other: 0 });
    expect(calls.GetRun + calls.GetRunTask + calls.GetWorkflow).toBeLessThanOrEqual(4);

    const taskItems = [...db.store.values()].filter((i) => i.entityType === 'TASK');
    expect(taskItems).toHaveLength(12);
    for (const item of taskItems) {
      expect(item.status).toBe('COMPLETED');
      for (const field of ['name', 'cpus', 'memory', 'instanceType', 'createdAt', 'startedAt', 'stoppedAt']) {
        expect(item[field], `${String(item.taskId)}.${field}`).toBeDefined();
      }
      expect(typeof item.cpus).toBe('number');
    }

    const runItem = db.store.get(`RUN#${REPLAY_RUN_ID}|RUN#${REPLAY_RUN_ID}`);
    expect(runItem).toMatchObject({
      status: 'COMPLETED',
      createdAt: RUN_CREATED,
      startedAt: RUN_STARTED,
      stoppedAt: RUN_STOPPED,
      workflowVersionName: 'v2-wave-fix',
      networkingMode: 'VPC',
    });
    expect(runItem?.outputUri).toBeDefined();
    expect(typeof runItem?.rawGetRun).toBe('string');

    // Every event published except the one stale write: task 6725384's
    // STARTING shares PENDING's event.time second, so the strict monotonic
    // guard preserves PENDING and the STARTING publish is skipped.
    const stale = logLines.filter((l) => l.msg === 'ingest_event' && l.publish === 'skipped-stale');
    expect(stale).toEqual([
      expect.objectContaining({ taskId: SAME_SECOND_TASK_ID, status: 'STARTING' }),
    ]);
    expect(publishedTasks).toHaveLength(48 - 1);
    expect(publishedRuns).toHaveLength(5);
    // Every run publish carries createdAt (cumulative merged item).
    for (const run of publishedRuns) {
      expect(run.createdAt).toBeDefined();
    }
    // Every task publish carries the event's descriptive fields.
    for (const task of publishedTasks) {
      expect(task.name).toBeDefined();
      expect(task.cpus).toBeDefined();
      expect(task.memory).toBeDefined();
    }
    // One ingest_event line per event.
    expect(logLines.filter((l) => l.msg === 'ingest_event')).toHaveLength(53);
  });

  it('api mode: legacy pattern of 12 GetRunTask + 5 GetRun + 1 GetWorkflow (207 + 5 + 1 on the full run)', async () => {
    const { calls } = await replay('api');
    expect(calls).toEqual({ GetRun: 5, GetRunTask: 12, GetWorkflow: 1, other: 0 });
  });

});
