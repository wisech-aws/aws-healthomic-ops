import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { zipSync, strToU8 } from 'fflate';

import { type OmicsClient } from '@aws-sdk/client-omics';

import { enrichRun, enrichTask, enrichTasks } from '../src/enrichment/tasks.js';
import { getWorkflowDefinition } from '../src/enrichment/workflow.js';
import { mergeRecords } from '../src/enrichment/merge.js';
import { callWithRetry, CallTimeoutError, backoffWithJitter } from '../src/enrichment/retry.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import type { RunRecord } from '../src/domain/records.js';

/**
 * The four (and only four) HealthOmics read operations enrichment is permitted
 * to invoke (Req 2.1). Any command whose name is outside this set is a
 * violation.
 */
const ALLOWED_OPERATIONS = new Set([
  'GetRunCommand',
  'ListRunTasksCommand',
  'GetRunTaskCommand',
  'GetWorkflowCommand',
]);

/**
 * A recording test double for the HealthOmics client. It captures the class
 * name of every command sent (so tests can assert which operations were
 * invoked, Property 3) and dispatches to a per-command-name response function.
 *
 * Response entries may be a value (resolved), a function of the command input
 * (resolved), or throw to simulate an API error. A missing entry rejects.
 */
type Responder = (input: unknown) => unknown;

function makeClient(responders: Record<string, Responder>): {
  client: OmicsClient;
  invoked: string[];
} {
  const invoked: string[] = [];
  const client = {
    send: vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
      const name = command.constructor.name;
      invoked.push(name);
      const responder = responders[name];
      if (!responder) {
        throw new Error(`unexpected command ${name}`);
      }
      return responder(command.input);
    }),
  } as unknown as OmicsClient;
  return { client, invoked };
}

// Fast options so retry/timeout paths run quickly and quietly in tests.
// A no-op `sleep` keeps retry backoff instantaneous in tests (the real
// helper now waits between attempts with exponential backoff + jitter).
const fastOptions = {
  timeoutMs: 50,
  maxAttempts: 3,
  sleep: async () => {},
  logger: () => undefined,
  // No-op limiter so tests aren't paced by the real 10 TPS (100ms/call) budget.
  rateLimiter: { acquire: async () => {} },
};

describe('mergeRecords', () => {
  it('preserves fields from both sources', () => {
    const event: Partial<RunRecord> = { runId: 'r1', status: RunStatus.RUNNING };
    const enriched: Partial<RunRecord> = { name: 'my run', workflowId: 'wf1' };
    expect(mergeRecords(event, enriched)).toEqual({
      runId: 'r1',
      status: RunStatus.RUNNING,
      name: 'my run',
      workflowId: 'wf1',
    });
  });

  it('lets the primary (event) source win on conflict', () => {
    const event: Partial<RunRecord> = { status: RunStatus.STOPPING };
    const enriched: Partial<RunRecord> = { status: RunStatus.RUNNING, name: 'n' };
    expect(mergeRecords(event, enriched)).toEqual({
      status: RunStatus.STOPPING,
      name: 'n',
    });
  });

  it('does not let undefined secondary fields overwrite defined event fields', () => {
    const event: Partial<RunRecord> = { name: 'kept' };
    const enriched: Partial<RunRecord> = { name: undefined, workflowId: 'wf1' };
    expect(mergeRecords(event, enriched)).toEqual({ name: 'kept', workflowId: 'wf1' });
  });

  it('equals the event fields alone when enrichment is empty (failed enrichment)', () => {
    const event: Partial<RunRecord> = { runId: 'r1', status: RunStatus.FAILED };
    expect(mergeRecords(event, {})).toEqual(event);
  });
});

describe('callWithRetry', () => {
  it('returns ok with the value on first success', async () => {
    const result = await callWithRetry('GetRun', 'r1', async () => 42, fastOptions);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('retries up to maxAttempts then returns a failed result (does not throw)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await callWithRetry('GetRun', 'r1', fn, fastOptions);
    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('logs the failed operation and identifier on persistent failure', async () => {
    const logger = vi.fn();
    await callWithRetry(
      'GetRun',
      'run-123',
      async () => {
        throw new Error('boom');
      },
      { ...fastOptions, logger },
    );
    const messages = logger.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('GetRun') && m.includes('run-123'))).toBe(true);
  });

  it('times out a slow call and treats it as a retryable failure', async () => {
    const fn = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 1000)),
    );
    const result = await callWithRetry('GetRun', 'r1', fn, {
      timeoutMs: 20,
      maxAttempts: 1,
      sleep: async () => {},
      logger: () => undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CallTimeoutError);
    }
  });
});

describe('enrichRun', () => {
  it('maps a GetRun response to a partial RunRecord', async () => {
    const { client, invoked } = makeClient({
      GetRunCommand: () => ({
        name: 'run name',
        status: 'RUNNING',
        workflowId: 'wf1',
        creationTime: new Date('2024-01-01T00:00:00.000Z'),
        startTime: new Date('2024-01-01T00:05:00.000Z'),
        stopTime: new Date('2024-01-01T01:00:00.000Z'),
      }),
    });
    const record = await enrichRun(client, 'r1', fastOptions);
    // Modeled first-class fields are mapped as before.
    expect(record).toMatchObject({
      name: 'run name',
      status: RunStatus.RUNNING,
      workflowId: 'wf1',
      createdAt: '2024-01-01T00:00:00.000Z',
      startedAt: '2024-01-01T00:05:00.000Z',
      stoppedAt: '2024-01-01T01:00:00.000Z',
    });
    // The full raw GetRun response is captured (Interpretation A) as a JSON
    // string, excluding the SDK's $metadata. It round-trips to the response.
    expect(record.rawGetRun).toBeDefined();
    const raw = JSON.parse(record.rawGetRun as string) as Record<string, unknown>;
    expect(raw).toMatchObject({
      name: 'run name',
      status: 'RUNNING',
      workflowId: 'wf1',
    });
    expect(raw).not.toHaveProperty('$metadata');
    expect(invoked).toEqual(['GetRunCommand']);
  });

  it('captures batchId and the full raw response when the run is part of a batch', async () => {
    const { client } = makeClient({
      GetRunCommand: () => ({
        name: 'batched run',
        status: 'COMPLETED',
        workflowId: 'wf1',
        batchId: '9998887',
        roleArn: 'arn:aws:iam::111122223333:role/omics',
        storageType: 'DYNAMIC',
      }),
    });
    const record = await enrichRun(client, 'r1', fastOptions);
    expect(record.batchId).toBe('9998887');
    expect(record.roleArn).toBe('arn:aws:iam::111122223333:role/omics');
    const raw = JSON.parse(record.rawGetRun as string) as Record<string, unknown>;
    expect(raw.batchId).toBe('9998887');
  });

  it('maps a non-empty tags map to a JSON string and omits an empty one', async () => {
    const withTags = makeClient({
      GetRunCommand: () => ({
        name: 'tagged run',
        status: 'RUNNING',
        workflowId: 'wf1',
        tags: { WorkflowName: 'nf-core-fetchngs', SampleID: 'SAMPLE-123' },
      }),
    });
    const rec = await enrichRun(withTags.client, 'r1', fastOptions);
    expect(rec.tags).toBeDefined();
    expect(JSON.parse(rec.tags as string)).toEqual({
      WorkflowName: 'nf-core-fetchngs',
      SampleID: 'SAMPLE-123',
    });

    const noTags = makeClient({
      GetRunCommand: () => ({ name: 'x', status: 'RUNNING', workflowId: 'wf1', tags: {} }),
    });
    const rec2 = await enrichRun(noTags.client, 'r1', fastOptions);
    expect(rec2.tags).toBeUndefined();
  });

  it('drops an unrecognized status value', async () => {
    const { client } = makeClient({
      GetRunCommand: () => ({ name: 'n', status: 'BOGUS' }),
    });
    const record = await enrichRun(client, 'r1', fastOptions);
    expect(record.status).toBeUndefined();
    expect(record.name).toBe('n');
  });

  it('returns an empty object and does not throw when GetRun fails after retries', async () => {
    const { client } = makeClient({
      GetRunCommand: () => {
        throw new Error('service error');
      },
    });
    await expect(enrichRun(client, 'r1', fastOptions)).resolves.toEqual({});
  });

  it('maps statusMessage and failureReason for a failed run', async () => {
    const { client } = makeClient({
      GetRunCommand: () => ({
        name: 'failed run',
        status: 'FAILED',
        workflowId: 'wf1',
        statusMessage:
          'Workflow run failed. Review the CloudWatch logs engine log stream to debug the failure.',
        failureReason: 'WORKFLOW_RUN_FAILED',
      }),
    });
    const record = await enrichRun(client, 'r1', fastOptions);
    expect(record.statusMessage).toBe(
      'Workflow run failed. Review the CloudWatch logs engine log stream to debug the failure.',
    );
    expect(record.failureReason).toBe('WORKFLOW_RUN_FAILED');
  });

  it('omits statusMessage/failureReason when absent (e.g. a healthy run)', async () => {
    const { client } = makeClient({
      GetRunCommand: () => ({ name: 'ok run', status: 'RUNNING', workflowId: 'wf1' }),
    });
    const record = await enrichRun(client, 'r1', fastOptions);
    expect(record.statusMessage).toBeUndefined();
    expect(record.failureReason).toBeUndefined();
  });
});

describe('enrichTasks', () => {
  it('lists tasks and enriches each via GetRunTask', async () => {
    const { client, invoked } = makeClient({
      ListRunTasksCommand: () => ({
        items: [
          { taskId: 't1', name: 'align', status: 'RUNNING' },
          { taskId: 't2', name: 'sort', status: 'PENDING' },
        ],
      }),
      GetRunTaskCommand: (input) => {
        const taskId = (input as { taskId: string }).taskId;
        return {
          taskId,
          name: taskId === 't1' ? 'align' : 'sort',
          status: taskId === 't1' ? 'COMPLETED' : 'RUNNING',
          cpus: 4,
          memory: 8,
          creationTime: new Date('2024-01-01T00:00:00.000Z'),
        };
      },
    });

    const records = await enrichTasks(client, 'run-1', fastOptions);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      runId: 'run-1',
      taskId: 't1',
      name: 'align',
      status: TaskStatus.COMPLETED,
      cpus: 4,
      memory: 8,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    // ListRunTasks once, GetRunTask per task.
    expect(invoked.filter((n) => n === 'ListRunTasksCommand')).toHaveLength(1);
    expect(invoked.filter((n) => n === 'GetRunTaskCommand')).toHaveLength(2);
  });

  it('follows the ListRunTasks pagination token', async () => {
    let call = 0;
    const { client, invoked } = makeClient({
      ListRunTasksCommand: () => {
        call += 1;
        return call === 1
          ? { items: [{ taskId: 't1', name: 'a' }], nextToken: 'next' }
          : { items: [{ taskId: 't2', name: 'b' }] };
      },
      GetRunTaskCommand: (input) => ({ taskId: (input as { taskId: string }).taskId }),
    });

    const records = await enrichTasks(client, 'run-1', fastOptions);
    expect(records.map((r) => r.taskId)).toEqual(['t1', 't2']);
    expect(invoked.filter((n) => n === 'ListRunTasksCommand')).toHaveLength(2);
  });

  it('falls back to ListRunTasks fields when GetRunTask fails', async () => {
    const { client } = makeClient({
      ListRunTasksCommand: () => ({
        items: [{ taskId: 't1', name: 'align', status: 'RUNNING' }],
      }),
      GetRunTaskCommand: () => {
        throw new Error('task detail failed');
      },
    });
    const records = await enrichTasks(client, 'run-1', fastOptions);
    expect(records).toEqual([
      { runId: 'run-1', taskId: 't1', name: 'align', status: TaskStatus.RUNNING },
    ]);
  });

  it('returns an empty array when ListRunTasks fails after retries', async () => {
    const { client } = makeClient({
      ListRunTasksCommand: () => {
        throw new Error('list failed');
      },
    });
    await expect(enrichTasks(client, 'run-1', fastOptions)).resolves.toEqual([]);
  });
});

describe('getWorkflowDefinition', () => {
  // The `definition` field is now a presigned URL; the bundle bytes come from an
  // injected `download` seam so tests never hit the network. `zipBundle` builds a
  // real zip of a File_Map that `unzipToFileMap` decodes back to the same map.
  const zipBundle = (files: Record<string, string>): Uint8Array =>
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, text]) => [path, strToU8(text)]),
      ),
    );
  const downloadOptions = (files: Record<string, string>) => ({
    ...fastOptions,
    download: async () => zipBundle(files),
  });

  it('resolves the definition bundle into a File_Map and maps the engine to a Language', async () => {
    const { client, invoked } = makeClient({
      GetWorkflowCommand: () => ({ definition: 'https://s3/bundle.zip', main: 'main', engine: 'WDL' }),
    });
    const def = await getWorkflowDefinition(
      client,
      'wf1',
      downloadOptions({ main: 'workflow {}' }),
    );
    expect(def).toEqual({
      workflowId: 'wf1',
      language: 'WDL',
      files: { main: 'workflow {}' },
      mainPath: 'main',
    });
    expect(invoked).toEqual(['GetWorkflowCommand']);
  });

  it('folds WDL_LENIENT into WDL', async () => {
    const { client } = makeClient({
      GetWorkflowCommand: () => ({ definition: 'https://s3/bundle.zip', engine: 'WDL_LENIENT' }),
    });
    const def = await getWorkflowDefinition(client, 'wf1', downloadOptions({ main: 'x' }));
    expect(def?.language).toBe('WDL');
  });

  it('preserves an unrecognized engine so the parser can reject it', async () => {
    const { client } = makeClient({
      GetWorkflowCommand: () => ({ definition: 'https://s3/bundle.zip', engine: 'SNAKEMAKE' }),
    });
    const def = await getWorkflowDefinition(client, 'wf1', downloadOptions({ main: 'x' }));
    expect(def?.language).toBe('SNAKEMAKE');
  });

  it('returns null when no inline definition source is present', async () => {
    const { client } = makeClient({
      GetWorkflowCommand: () => ({ engine: 'WDL' }),
    });
    await expect(getWorkflowDefinition(client, 'wf1', fastOptions)).resolves.toBeNull();
  });

  it('returns null and does not throw when GetWorkflow fails after retries', async () => {
    const { client } = makeClient({
      GetWorkflowCommand: () => {
        throw new Error('service error');
      },
    });
    await expect(getWorkflowDefinition(client, 'wf1', fastOptions)).resolves.toBeNull();
  });
});

/**
 * Feature: healthomics-workflow-dashboard, Property 2: Enrichment merge
 * preserves both sources.
 *
 * For any pair of an event-derived field set and an enrichment-derived field
 * set, the persisted record equals the merge of both (event wins on conflict),
 * and for any event whose enrichment fails (empty enrichment), the persisted
 * record is derived solely from the event fields with unretrieved fields unset.
 *
 * Validates: Requirements 2.4, 2.5
 */
describe('Property 2: enrichment merge preserves both sources', () => {
  // Arbitraries over the optional string fields shared by RunRecord.
  const optionalString = fc.option(fc.string(), { nil: undefined });
  const runFields = fc.record<Partial<RunRecord>>(
    {
      name: optionalString,
      workflowId: optionalString,
      workflowName: optionalString,
      createdAt: optionalString,
      startedAt: optionalString,
      stoppedAt: optionalString,
    },
    { requiredKeys: [] },
  );

  it('merges both sources with the event winning, over 100+ cases', () => {
    fc.assert(
      fc.property(runFields, runFields, (eventFields, enrichedFields) => {
        const merged = mergeRecords(eventFields, enrichedFields);

        // Every defined key of either source is represented in the merge.
        const definedKeys = new Set<string>();
        for (const [k, v] of Object.entries(enrichedFields)) {
          if (v !== undefined) definedKeys.add(k);
        }
        for (const [k, v] of Object.entries(eventFields)) {
          if (v !== undefined) definedKeys.add(k);
        }
        expect(new Set(Object.keys(merged))).toEqual(definedKeys);

        // On conflict the event value wins; otherwise the enrichment value.
        for (const key of definedKeys) {
          const k = key as keyof RunRecord;
          const eventVal = eventFields[k];
          const expected = eventVal !== undefined ? eventVal : enrichedFields[k];
          expect(merged[k]).toBe(expected);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('equals the event fields alone when enrichment yields nothing', () => {
    fc.assert(
      fc.property(runFields, (eventFields) => {
        const merged = mergeRecords(eventFields, {});
        const eventOnly: Partial<RunRecord> = {};
        for (const [k, v] of Object.entries(eventFields)) {
          if (v !== undefined) (eventOnly as Record<string, unknown>)[k] = v;
        }
        expect(merged).toEqual(eventOnly);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Feature: healthomics-workflow-dashboard, Property 3: Enrichment uses only
 * allowed read operations.
 *
 * For any enrichment execution, the set of HealthOmics operations invoked is a
 * subset of {GetRun, ListRunTasks, GetRunTask, GetWorkflow}.
 *
 * Validates: Requirements 2.1
 */
describe('Property 3: enrichment uses only allowed read operations', () => {
  it('invokes only allowed operations across success and failure paths', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A random mix of: which calls succeed vs fail, and how many tasks.
        fc.record({
          runOk: fc.boolean(),
          listOk: fc.boolean(),
          taskOk: fc.boolean(),
          workflowOk: fc.boolean(),
          taskCount: fc.integer({ min: 0, max: 4 }),
        }),
        async (cfg) => {
          const items = Array.from({ length: cfg.taskCount }, (_, i) => ({
            taskId: `t${i}`,
            name: `task-${i}`,
            status: 'RUNNING',
          }));

          const { client, invoked } = makeClient({
            GetRunCommand: () => {
              if (!cfg.runOk) throw new Error('fail');
              return { name: 'n', status: 'RUNNING' };
            },
            ListRunTasksCommand: () => {
              if (!cfg.listOk) throw new Error('fail');
              return { items };
            },
            GetRunTaskCommand: (input) => {
              if (!cfg.taskOk) throw new Error('fail');
              return { taskId: (input as { taskId: string }).taskId };
            },
            GetWorkflowCommand: () => {
              if (!cfg.workflowOk) throw new Error('fail');
              return { definition: 'workflow {}', engine: 'WDL' };
            },
          });

          await enrichRun(client, 'r1', fastOptions);
          await enrichTasks(client, 'r1', fastOptions);
          // Inject a download seam so the definition fetch stays hermetic; the
          // property only asserts which SDK operations were invoked.
          await getWorkflowDefinition(client, 'wf1', {
            ...fastOptions,
            download: async () => zipSync({ 'main': strToU8('workflow {}') }),
          });

          for (const name of invoked) {
            expect(ALLOWED_OPERATIONS.has(name)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


describe('enrichTask (single-task enrichment, anti-amplification)', () => {
  it('fetches exactly one task via one GetRunTask (no ListRunTasks)', async () => {
    const { client, invoked } = makeClient({
      GetRunTaskCommand: (input) => ({
        taskId: (input as { taskId: string }).taskId,
        name: 'align',
        status: 'COMPLETED',
        cpus: 4,
        memory: 8,
        creationTime: new Date('2024-01-01T00:00:00.000Z'),
        startTime: new Date('2024-01-01T00:01:00.000Z'),
        stopTime: new Date('2024-01-01T00:05:00.000Z'),
      }),
    });
    const record = await enrichTask(client, 'run-1', 't1', fastOptions);
    expect(record).toMatchObject({
      runId: 'run-1',
      taskId: 't1',
      name: 'align',
      status: TaskStatus.COMPLETED,
      startedAt: '2024-01-01T00:01:00.000Z',
      stoppedAt: '2024-01-01T00:05:00.000Z',
    });
    // Crucially: only ONE call, and never ListRunTasks (the amplification source).
    expect(invoked).toEqual(['GetRunTaskCommand']);
  });

  it('returns just {runId} when GetRunTask fails after retries', async () => {
    const { client } = makeClient({
      GetRunTaskCommand: () => {
        throw new Error('boom');
      },
    });
    await expect(enrichTask(client, 'run-1', 't1', fastOptions)).resolves.toEqual({
      runId: 'run-1',
    });
  });

  it('maps statusMessage and failureReason for a failed task', async () => {
    const { client } = makeClient({
      GetRunTaskCommand: (input) => ({
        taskId: (input as { taskId: string }).taskId,
        name: 'SRA_IDS_TO_RUNINFO (SRR13191702)',
        status: 'FAILED',
        statusMessage:
          'Run failed due to task: NFCORE_FETCHNGS:SRA:SRA_IDS_TO_RUNINFO (SRR13191702), id: 8447635, failure.',
        failureReason: 'RUN_TASK_FAILED',
      }),
    });
    const record = await enrichTask(client, 'run-1', 't1', fastOptions);
    expect(record.statusMessage).toBe(
      'Run failed due to task: NFCORE_FETCHNGS:SRA:SRA_IDS_TO_RUNINFO (SRR13191702), id: 8447635, failure.',
    );
    expect(record.failureReason).toBe('RUN_TASK_FAILED');
  });

  it('omits statusMessage/failureReason when absent (e.g. a healthy task)', async () => {
    const { client } = makeClient({
      GetRunTaskCommand: (input) => ({
        taskId: (input as { taskId: string }).taskId,
        name: 'align',
        status: 'COMPLETED',
      }),
    });
    const record = await enrichTask(client, 'run-1', 't1', fastOptions);
    expect(record.statusMessage).toBeUndefined();
    expect(record.failureReason).toBeUndefined();
  });
});

describe('backoffWithJitter', () => {
  it('grows exponentially (with the base) and is capped', () => {
    // random()=1 yields the full (unjittered) delay for a clear schedule check.
    const one = () => 1;
    expect(backoffWithJitter(0, 250, 5000, one)).toBe(250);
    expect(backoffWithJitter(1, 250, 5000, one)).toBe(500);
    expect(backoffWithJitter(2, 250, 5000, one)).toBe(1000);
    // Capped at maxDelay.
    expect(backoffWithJitter(10, 250, 5000, one)).toBe(5000);
  });

  it('applies full jitter: delay in [0, cappedExp)', () => {
    const half = () => 0.5;
    expect(backoffWithJitter(2, 250, 5000, half)).toBe(500); // floor(0.5*1000)
    const zero = () => 0;
    expect(backoffWithJitter(3, 250, 5000, zero)).toBe(0);
  });
});
