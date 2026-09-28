import { describe, it, expect, vi } from 'vitest';
import type { EventBridgeEvent } from 'aws-lambda';

import {
  createHandler,
  type IngestRepository,
  type IngestEnricher,
  type IngestPublisher,
  type IngestSummarizer,
} from '../src/handler.js';
import type {
  RunRecord,
  TaskRecord,
  RunSummaryRecord,
} from '../src/domain/records.js';
import { UNVERSIONED_LABEL } from '../src/domain/records.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import type { StaticGraph } from '../src/parser/types.js';
import type { TaskItem } from '../src/repository.js';
import type { MetricSeries } from '../src/metrics/parse.js';

const REGION = 'us-east-1';
const BYTES_PER_GIB = 1024 ** 3;

function taskItem(partial: Partial<TaskItem> = {}): TaskItem {
  return {
    PK: 'RUN#r-1',
    SK: `TASK#${partial.taskId ?? 't-1'}`,
    runId: 'r-1',
    taskId: 't-1',
    updatedAt: '2026-09-25T13:00:00.000Z',
    entityType: 'TASK',
    status: TaskStatus.COMPLETED,
    startedAt: '2026-09-25T12:00:00.000Z',
    stoppedAt: '2026-09-25T13:00:00.000Z',
    cpus: 4,
    ...partial,
  };
}

function memSeries(bytes: number[]): MetricSeries {
  return {
    metricName: 'aws.omics.task.memory.usage',
    family: 'MEMORY',
    role: 'usage',
    unit: 'By',
    taskId: 't-1',
    direction: null,
    scratchMode: null,
    gpuId: null,
    points: bytes.map((value, i) => ({ timestamp: i * 30_000, value })),
  };
}

function makeDeps(opts: {
  summaries: RunSummaryRecord[];
  taskItems?: TaskItem[];
  summarizer?: IngestSummarizer;
  repoOverrides?: Partial<IngestRepository>;
  registryCalls?: Array<{ name: string; version: string; workflowId: string | undefined }>;
}) {
  const repo: IngestRepository = {
    upsertRun: async () => ({ outcome: 'written' }),
    upsertTask: async () => ({ outcome: 'written' }),
    getStaticGraph: async (): Promise<StaticGraph | null> => null,
    putStaticGraph: async () => {},
    recordGraphFailure: async () => {},
    upsertSummary: async (s) => {
      opts.summaries.push(s);
      return { outcome: 'written' };
    },
    listTaskItemsForRun: async () => opts.taskItems ?? [taskItem()],
    upsertGroupRegistry: async (name, version, workflowId) => {
      opts.registryCalls?.push({ name, version, workflowId });
      return {};
    },
    ...opts.repoOverrides,
  };
  const enricher: IngestEnricher = {
    // Enrichment fills the render fields + timing the run event itself lacks
    // (the mapper only reads runId/status/runName/workflowId/workflowName).
    enrichRun: async () => ({
      name: 'my-run',
      workflowName: 'nf-core-fetchngs',
      createdAt: '2026-09-25T11:59:00.000Z',
      startedAt: '2026-09-25T12:00:00.000Z',
      stoppedAt: '2026-09-25T13:00:00.000Z',
    }),
    enrichTask: async () => ({}),
    getWorkflowDefinition: async () => null,
  };
  const publisher: IngestPublisher = {
    publishRunUpdate: async () => ({ outcome: 'published' }),
    publishTaskUpdate: async () => ({ outcome: 'published' }),
  };
  return { repository: repo, enricher, publisher, summarizer: opts.summarizer };
}

function runEvent(detail: Record<string, unknown>): EventBridgeEvent<string, unknown> {
  return {
    version: '0',
    id: 'evt-run',
    'detail-type': 'Run Status Change',
    source: 'aws.omics',
    account: '123456789012',
    time: '2026-09-25T13:00:01.000Z',
    region: REGION,
    resources: [],
    detail,
  };
}

// A terminal run detail carrying only the fields the mapper reads; timing and
// name are supplied by enrichment (see makeDeps.enricher).
function terminalRunDetail(status: string): Record<string, unknown> {
  return {
    runId: 'r-1',
    status,
    runName: 'my-run',
    workflowId: 'wf-1',
  };
}

describe('completion hook — Run_Summary at terminal state', () => {
  it('writes exactly one summary for a terminal run, versionless => (unversioned)', async () => {
    const summaries: RunSummaryRecord[] = [];
    const summarizer: IngestSummarizer = {
      fetchRunMetricSeries: vi.fn(async () => [memSeries([6 * BYTES_PER_GIB, 3 * BYTES_PER_GIB])]),
    };
    const deps = makeDeps({ summaries, summarizer });
    const handler = createHandler(deps);

    await handler(runEvent(terminalRunDetail('COMPLETED')));

    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.runId).toBe('r-1');
    expect(s.status).toBe(RunStatus.COMPLETED);
    expect(s.workflowVersionName).toBe(UNVERSIONED_LABEL);
    // Duration from run window = 1h.
    expect(s.durationAvailable).toBe(true);
    expect(s.durationMs).toBe(3_600_000);
    // Memory swept => GiB peak 6.
    expect(s.memoryAvailable).toBe(true);
    expect(s.peakMemoryGiB).toBeCloseTo(6, 6);
    // Task shape.
    expect(s.taskCount).toBe(1);
  });

  it('does NOT write a summary for a non-terminal (RUNNING) run', async () => {
    const summaries: RunSummaryRecord[] = [];
    const deps = makeDeps({ summaries });
    const handler = createHandler(deps);

    await handler(runEvent(terminalRunDetail('RUNNING')));

    expect(summaries).toHaveLength(0);
  });

  it('flags utilization unavailable when no summarizer is wired (never fabricated)', async () => {
    const summaries: RunSummaryRecord[] = [];
    const deps = makeDeps({ summaries }); // no summarizer
    const handler = createHandler(deps);

    await handler(runEvent(terminalRunDetail('COMPLETED')));

    expect(summaries).toHaveLength(1);
    expect(summaries[0].memoryAvailable).toBe(false);
    expect(summaries[0].meanMemoryGiB).toBeUndefined();
    // But task-derived facts are still present.
    expect(summaries[0].durationAvailable).toBe(true);
    expect(summaries[0].cpuHoursAvailable).toBe(true); // task carries cpus=4
  });

  it('isolates a summary failure: run is still published, no throw', async () => {
    const summaries: RunSummaryRecord[] = [];
    const published: string[] = [];
    const deps = makeDeps({
      summaries,
      repoOverrides: {
        upsertSummary: async () => {
          throw new Error('dynamo down');
        },
      },
    });
    deps.publisher.publishRunUpdate = async (run) => {
      published.push(run.runId);
      return { outcome: 'published' };
    };
    const handler = createHandler(deps);

    // Must not throw despite the summary write failing.
    await expect(handler(runEvent(terminalRunDetail('FAILED')))).resolves.toBeUndefined();
    expect(published).toEqual(['r-1']);
    expect(summaries).toHaveLength(0);
  });

  it('isolates a metrics-sweep failure: summary still written with utilization unavailable', async () => {
    const summaries: RunSummaryRecord[] = [];
    const summarizer: IngestSummarizer = {
      fetchRunMetricSeries: async () => {
        throw new Error('cloudwatch throttled');
      },
    };
    const deps = makeDeps({ summaries, summarizer });
    const handler = createHandler(deps);

    await handler(runEvent(terminalRunDetail('COMPLETED')));

    expect(summaries).toHaveLength(1);
    expect(summaries[0].memoryAvailable).toBe(false);
    expect(summaries[0].cpuAvailable).toBe(false);
  });

  it('upserts the Group_Registry for a terminal run (name, version, workflowId)', async () => {
    const summaries: RunSummaryRecord[] = [];
    const registryCalls: Array<{ name: string; version: string; workflowId: string | undefined }> = [];
    const deps = makeDeps({ summaries, registryCalls });
    const handler = createHandler(deps);

    await handler(runEvent(terminalRunDetail('COMPLETED')));

    expect(registryCalls).toHaveLength(1);
    expect(registryCalls[0]).toEqual({
      name: 'nf-core-fetchngs',
      version: UNVERSIONED_LABEL,
      workflowId: 'wf-1',
    });
  });

  it('isolates a Group_Registry failure: summary still written, no throw', async () => {
    const summaries: RunSummaryRecord[] = [];
    const deps = makeDeps({
      summaries,
      repoOverrides: {
        upsertGroupRegistry: async () => {
          throw new Error('registry down');
        },
      },
    });
    const handler = createHandler(deps);
    await expect(handler(runEvent(terminalRunDetail('COMPLETED')))).resolves.toBeUndefined();
    expect(summaries).toHaveLength(1);
  });
});
