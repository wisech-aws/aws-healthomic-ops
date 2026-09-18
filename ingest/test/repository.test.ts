import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import {
  DynamoRepository,
  InvalidIdentifierError,
  MAX_WRITE_ATTEMPTS,
  RUNS_GSI1PK,
  UpsertWriteError,
  buildGraphItem,
  buildRunItem,
  buildTaskItem,
  graphPk,
  graphSk,
  normalizeGsi1Sk,
  runPk,
  runSk,
  taskSk,
} from '../src/repository.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import type { RunRecord, TaskRecord } from '../src/domain/records.js';
import type { StaticGraph } from '../src/parser/types.js';

describe('key derivation', () => {
  it('derives run PK and SK as RUN#<runId>', () => {
    expect(runPk('r-123')).toBe('RUN#r-123');
    expect(runSk('r-123')).toBe('RUN#r-123');
  });

  it('derives task SK as TASK#<taskId>', () => {
    expect(taskSk('t-9')).toBe('TASK#t-9');
  });

  it('keeps run PK === SK for the same runId', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (runId) => {
        expect(runPk(runId)).toBe(runSk(runId));
      }),
    );
  });
});

describe('normalizeGsi1Sk', () => {
  it('normalizes a valid ISO 8601 timestamp to UTC millisecond precision', () => {
    // Offset timestamp is converted to UTC with ms precision.
    expect(normalizeGsi1Sk('2024-01-02T03:04:05.678Z')).toBe(
      '2024-01-02T03:04:05.678Z',
    );
    expect(normalizeGsi1Sk('2024-01-02T05:04:05+02:00')).toBe(
      '2024-01-02T03:04:05.000Z',
    );
  });

  it('pads sub-millisecond and second-precision timestamps to ms precision', () => {
    expect(normalizeGsi1Sk('2024-01-02T03:04:05Z')).toBe(
      '2024-01-02T03:04:05.000Z',
    );
  });

  it('returns undefined for missing or empty input', () => {
    expect(normalizeGsi1Sk(undefined)).toBeUndefined();
    expect(normalizeGsi1Sk('')).toBeUndefined();
    expect(normalizeGsi1Sk('   ')).toBeUndefined();
  });

  it('returns undefined for non-ISO-8601 strings', () => {
    expect(normalizeGsi1Sk('not-a-date')).toBeUndefined();
    expect(normalizeGsi1Sk('01/02/2024')).toBeUndefined();
    expect(normalizeGsi1Sk('2024-01-02')).toBeUndefined(); // date-only, no time
    expect(normalizeGsi1Sk('2024-13-40T99:99:99Z')).toBeUndefined();
  });

  it('always yields canonical UTC ms-precision output for valid ISO instants (property)', () => {
    // Validates: Requirements 3.3
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('2999-12-31T23:59:59.999Z'),
          // Constrain to valid, finite dates so the generator never yields
          // `new Date(NaN)`, which would make `toISOString()` throw a
          // RangeError and cause a flaky failure.
          noInvalidDate: true,
        }),
        (date) => {
          const iso = date.toISOString();
          const normalized = normalizeGsi1Sk(iso);
          expect(normalized).toBe(iso);
          // Canonical shape: ends in Z, has ms precision.
          expect(normalized).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          );
        },
      ),
    );
  });
});

describe('buildRunItem', () => {
  it('builds a full run item with keys, attributes, GSI1, and entityType', () => {
    const run: RunRecord = {
      runId: 'r-1',
      status: RunStatus.RUNNING,
      name: 'my-run',
      createdAt: '2024-01-01T00:00:00.000Z',
      startedAt: '2024-01-01T00:01:00.000Z',
      stoppedAt: '2024-01-01T00:02:00.000Z',
      updatedAt: '2024-01-01T00:03:00.000Z',
      workflowId: 'wf-1',
      workflowName: 'wf-name',
    };

    expect(buildRunItem(run)).toEqual({
      PK: 'RUN#r-1',
      SK: 'RUN#r-1',
      GSI1PK: RUNS_GSI1PK,
      GSI1SK: '2024-01-01T00:03:00.000Z',
      runId: 'r-1',
      status: 'RUNNING',
      name: 'my-run',
      createdAt: '2024-01-01T00:00:00.000Z',
      startedAt: '2024-01-01T00:01:00.000Z',
      stoppedAt: '2024-01-01T00:02:00.000Z',
      updatedAt: '2024-01-01T00:03:00.000Z',
      workflowId: 'wf-1',
      workflowName: 'wf-name',
      entityType: 'RUN',
    });
  });

  it('omits absent optional attributes', () => {
    const run: RunRecord = {
      runId: 'r-2',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const item = buildRunItem(run);
    expect(item).toEqual({
      PK: 'RUN#r-2',
      SK: 'RUN#r-2',
      GSI1PK: RUNS_GSI1PK,
      GSI1SK: '2024-01-01T00:00:00.000Z',
      runId: 'r-2',
      updatedAt: '2024-01-01T00:00:00.000Z',
      entityType: 'RUN',
    });
    expect('status' in item).toBe(false);
    expect('workflowId' in item).toBe(false);
  });

  it('omits GSI1PK/GSI1SK when updatedAt is not a valid ISO 8601 timestamp', () => {
    const run: RunRecord = {
      runId: 'r-3',
      updatedAt: 'not-a-timestamp',
    };

    const item = buildRunItem(run);
    expect('GSI1PK' in item).toBe(false);
    expect('GSI1SK' in item).toBe(false);
    // The raw updatedAt is still stored as an attribute (Req 3.4).
    expect(item.updatedAt).toBe('not-a-timestamp');
  });

  it('always sets PK === SK === RUN#<runId> and entityType RUN (property)', () => {
    // Validates: Requirements 3.1
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (runId, updatedAt) => {
        const item = buildRunItem({ runId, updatedAt });
        expect(item.PK).toBe(`RUN#${runId}`);
        expect(item.SK).toBe(`RUN#${runId}`);
        expect(item.runId).toBe(runId);
        expect(item.entityType).toBe('RUN');
      }),
    );
  });

  it('carries statusMessage and failureReason when present (e.g. a failed run)', () => {
    const run: RunRecord = {
      runId: 'r-4',
      status: RunStatus.FAILED,
      updatedAt: '2024-01-01T00:00:00.000Z',
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
      failureReason: 'WORKFLOW_RUN_FAILED',
    };
    const item = buildRunItem(run);
    expect(item.statusMessage).toBe('Workflow run failed. Review the CloudWatch logs...');
    expect(item.failureReason).toBe('WORKFLOW_RUN_FAILED');
  });

  it('omits statusMessage/failureReason when absent', () => {
    const item = buildRunItem({ runId: 'r-5', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect('statusMessage' in item).toBe(false);
    expect('failureReason' in item).toBe(false);
  });
});

describe('buildTaskItem', () => {
  it('builds a full task item with keys, attributes, and entityType', () => {
    const task: TaskRecord = {
      runId: 'r-1',
      taskId: 't-1',
      status: TaskStatus.COMPLETED,
      name: 'align',
      createdAt: '2024-01-01T00:00:00.000Z',
      startedAt: '2024-01-01T00:01:00.000Z',
      stoppedAt: '2024-01-01T00:02:00.000Z',
      updatedAt: '2024-01-01T00:03:00.000Z',
      cpus: 4,
      memory: 8,
    };

    expect(buildTaskItem(task)).toEqual({
      PK: 'RUN#r-1',
      SK: 'TASK#t-1',
      runId: 'r-1',
      taskId: 't-1',
      status: 'COMPLETED',
      name: 'align',
      createdAt: '2024-01-01T00:00:00.000Z',
      startedAt: '2024-01-01T00:01:00.000Z',
      stoppedAt: '2024-01-01T00:02:00.000Z',
      updatedAt: '2024-01-01T00:03:00.000Z',
      cpus: 4,
      memory: 8,
      entityType: 'TASK',
    });
  });

  it('omits absent optional attributes and does not set GSI1 keys', () => {
    const task: TaskRecord = {
      runId: 'r-2',
      taskId: 't-2',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    const item = buildTaskItem(task);
    expect(item).toEqual({
      PK: 'RUN#r-2',
      SK: 'TASK#t-2',
      runId: 'r-2',
      taskId: 't-2',
      updatedAt: '2024-01-01T00:00:00.000Z',
      entityType: 'TASK',
    });
    expect('GSI1PK' in item).toBe(false);
    expect('GSI1SK' in item).toBe(false);
    expect('cpus' in item).toBe(false);
  });

  it('always derives PK RUN#<runId>, SK TASK#<taskId>, entityType TASK (property)', () => {
    // Validates: Requirements 3.2
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string(),
        (runId, taskId, updatedAt) => {
          const item = buildTaskItem({ runId, taskId, updatedAt });
          expect(item.PK).toBe(`RUN#${runId}`);
          expect(item.SK).toBe(`TASK#${taskId}`);
          expect(item.runId).toBe(runId);
          expect(item.taskId).toBe(taskId);
          expect(item.entityType).toBe('TASK');
        },
      ),
    );
  });

  it('carries statusMessage and failureReason when present (e.g. a failed task)', () => {
    const task: TaskRecord = {
      runId: 'r-3',
      taskId: 't-3',
      status: TaskStatus.FAILED,
      updatedAt: '2024-01-01T00:00:00.000Z',
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    };
    const item = buildTaskItem(task);
    expect(item.statusMessage).toBe('Run failed due to task: ... failure.');
    expect(item.failureReason).toBe('RUN_TASK_FAILED');
  });

  it('omits statusMessage/failureReason when absent', () => {
    const item = buildTaskItem({ runId: 'r-4', taskId: 't-4', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect('statusMessage' in item).toBe(false);
    expect('failureReason' in item).toBe(false);
  });
});

/**
 * In-memory DynamoDB document-client double.
 *
 * It understands only the single `PutCommand` shape the repository issues: a
 * put guarded by `attribute_not_exists(PK) OR :incomingUpdatedAt >
 * #storedUpdatedAt`. It stores items keyed by `PK|SK` and enforces the
 * monotonic condition exactly as DynamoDB would, throwing a
 * `ConditionalCheckFailedException` when the condition is not met. An optional
 * fault injector lets tests simulate transient write failures for the retry
 * behavior (Req 3.10). This is a real evaluation of the write semantics, not a
 * mock that rubber-stamps success.
 */
class InMemoryDocClient {
  readonly store = new Map<string, Record<string, unknown>>();
  sendCount = 0;

  /**
   * When set, invoked before each write with the current attempt number
   * (1-based). Return an Error to make that attempt fail transiently, or
   * undefined to let it proceed.
   */
  failNext?: (attempt: number) => Error | undefined;
  private attempt = 0;

  async send(command: PutCommand): Promise<unknown> {
    this.sendCount += 1;
    this.attempt += 1;

    if (this.failNext) {
      const injected = this.failNext(this.attempt);
      if (injected) {
        throw injected;
      }
    }

    const input = command.input;
    const item = input.Item as Record<string, unknown>;
    const key = `${String(item.PK)}|${String(item.SK)}`;
    const incoming = input.ExpressionAttributeValues?.[':incomingUpdatedAt'] as
      | string
      | undefined;

    const existing = this.store.get(key);
    // attribute_not_exists(PK) OR :incomingUpdatedAt > #storedUpdatedAt
    const conditionMet =
      existing === undefined ||
      (incoming !== undefined &&
        typeof existing.updatedAt === 'string' &&
        incoming > existing.updatedAt);

    if (!conditionMet) {
      throw new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      });
    }

    this.store.set(key, { ...item });
    return {};
  }

  /** Reset the per-instance transient-failure attempt counter. */
  resetAttempts(): void {
    this.attempt = 0;
  }

  asDocClient(): DynamoDBDocumentClient {
    return this as unknown as DynamoDBDocumentClient;
  }
}

const TABLE = 'test-table';

function makeRepo(): { repo: DynamoRepository; db: InMemoryDocClient } {
  const db = new InMemoryDocClient();
  const repo = new DynamoRepository(db.asDocClient(), TABLE);
  return { repo, db };
}

describe('DynamoRepository.upsertRun / upsertTask - conditional monotonic upsert', () => {
  it('writes a new run item when none exists', async () => {
    const { repo, db } = makeRepo();
    const result = await repo.upsertRun({
      runId: 'r-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      status: RunStatus.RUNNING,
    });

    expect(result).toEqual({ outcome: 'written', runId: 'r-1', taskId: undefined });
    expect(db.store.get('RUN#r-1|RUN#r-1')?.status).toBe('RUNNING');
  });

  it('overwrites when the incoming run updatedAt is strictly greater', async () => {
    const { repo, db } = makeRepo();
    await repo.upsertRun({ runId: 'r-1', updatedAt: '2024-01-01T00:00:00.000Z', status: RunStatus.PENDING });
    const result = await repo.upsertRun({
      runId: 'r-1',
      updatedAt: '2024-01-01T00:00:01.000Z',
      status: RunStatus.RUNNING,
    });

    expect(result.outcome).toBe('written');
    expect(db.store.get('RUN#r-1|RUN#r-1')?.status).toBe('RUNNING');
  });

  it('preserves the stored run when the incoming updatedAt is equal (no-op)', async () => {
    const { repo, db } = makeRepo();
    await repo.upsertRun({ runId: 'r-1', updatedAt: '2024-01-01T00:00:00.000Z', status: RunStatus.RUNNING });
    const result = await repo.upsertRun({
      runId: 'r-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      status: RunStatus.FAILED,
    });

    expect(result.outcome).toBe('preserved');
    // Existing attributes untouched (Req 3.8).
    expect(db.store.get('RUN#r-1|RUN#r-1')?.status).toBe('RUNNING');
  });

  it('preserves the stored run when the incoming updatedAt is older (no-op)', async () => {
    const { repo, db } = makeRepo();
    await repo.upsertRun({ runId: 'r-1', updatedAt: '2024-01-01T00:00:05.000Z', status: RunStatus.RUNNING });
    const result = await repo.upsertRun({
      runId: 'r-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      status: RunStatus.FAILED,
    });

    expect(result.outcome).toBe('preserved');
    expect(db.store.get('RUN#r-1|RUN#r-1')?.status).toBe('RUNNING');
  });

  it('writes and preserves task items with the same monotonic rule', async () => {
    const { repo, db } = makeRepo();
    const first = await repo.upsertTask({
      runId: 'r-1',
      taskId: 't-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      status: TaskStatus.RUNNING,
    });
    expect(first).toEqual({ outcome: 'written', runId: 'r-1', taskId: 't-1' });

    const stale = await repo.upsertTask({
      runId: 'r-1',
      taskId: 't-1',
      updatedAt: '2023-12-31T00:00:00.000Z',
      status: TaskStatus.FAILED,
    });
    expect(stale.outcome).toBe('preserved');
    expect(db.store.get('RUN#r-1|TASK#t-1')?.status).toBe('RUNNING');
  });

  it('re-applying an already-stored upsert is idempotent', async () => {
    const { repo, db } = makeRepo();
    const record: RunRecord = {
      runId: 'r-1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      status: RunStatus.COMPLETED,
    };
    await repo.upsertRun(record);
    const before = { ...db.store.get('RUN#r-1|RUN#r-1') };
    const again = await repo.upsertRun(record);

    expect(again.outcome).toBe('preserved');
    expect(db.store.get('RUN#r-1|RUN#r-1')).toEqual(before);
  });
});

describe('DynamoRepository - identifier validation (Req 3.9)', () => {
  it('rejects a run upsert with an empty runId, leaving the store unchanged', async () => {
    const { repo, db } = makeRepo();
    await expect(repo.upsertRun({ runId: '', updatedAt: '2024-01-01T00:00:00.000Z' })).rejects.toBeInstanceOf(
      InvalidIdentifierError,
    );
    expect(db.sendCount).toBe(0);
    expect(db.store.size).toBe(0);
  });

  it('rejects a run upsert with a whitespace-only runId naming the attribute', async () => {
    const { repo } = makeRepo();
    await expect(
      repo.upsertRun({ runId: '   ', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ attribute: 'runId' });
  });

  it('rejects a task upsert with an empty runId before touching the store', async () => {
    const { repo, db } = makeRepo();
    await expect(
      repo.upsertTask({ runId: '', taskId: 't-1', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ attribute: 'runId' });
    expect(db.sendCount).toBe(0);
  });

  it('rejects a task upsert with an empty taskId naming taskId', async () => {
    const { repo, db } = makeRepo();
    await expect(
      repo.upsertTask({ runId: 'r-1', taskId: '', updatedAt: '2024-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ attribute: 'taskId' });
    expect(db.sendCount).toBe(0);
    expect(db.store.size).toBe(0);
  });
});

describe('DynamoRepository - write retry behavior (Req 3.10)', () => {
  it('retries transient failures and succeeds within MAX_WRITE_ATTEMPTS', async () => {
    const { repo, db } = makeRepo();
    // Fail the first two attempts, succeed on the third.
    db.failNext = (attempt) => (attempt < MAX_WRITE_ATTEMPTS ? new Error('transient') : undefined);

    const result = await repo.upsertRun({ runId: 'r-1', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect(result.outcome).toBe('written');
    expect(db.sendCount).toBe(MAX_WRITE_ATTEMPTS);
  });

  it('throws UpsertWriteError identifying runId when all attempts fail, leaving store unchanged', async () => {
    const { repo, db } = makeRepo();
    db.failNext = () => new Error('persistent boom');

    await expect(repo.upsertRun({ runId: 'r-1', updatedAt: '2024-01-01T00:00:00.000Z' })).rejects.toMatchObject({
      name: 'UpsertWriteError',
      runId: 'r-1',
      taskId: undefined,
    });
    expect(db.sendCount).toBe(MAX_WRITE_ATTEMPTS);
    expect(db.store.size).toBe(0);
  });

  it('throws UpsertWriteError identifying runId/taskId for a failed task write', async () => {
    const { repo, db } = makeRepo();
    db.failNext = () => new Error('persistent boom');

    const err = await repo
      .upsertTask({ runId: 'r-9', taskId: 't-9', updatedAt: '2024-01-01T00:00:00.000Z' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpsertWriteError);
    expect((err as UpsertWriteError).runId).toBe('r-9');
    expect((err as UpsertWriteError).taskId).toBe('t-9');
    expect(db.store.size).toBe(0);
  });

  it('does not retry a conditional-check failure (treats it as a no-op)', async () => {
    const { repo, db } = makeRepo();
    await repo.upsertRun({ runId: 'r-1', updatedAt: '2024-01-01T00:00:05.000Z' });
    db.sendCount = 0;

    const result = await repo.upsertRun({ runId: 'r-1', updatedAt: '2024-01-01T00:00:00.000Z' });
    expect(result.outcome).toBe('preserved');
    // Exactly one send: the condition failed and we did NOT retry.
    expect(db.sendCount).toBe(1);
  });
});

describe('DynamoRepository - monotonic invariant (property)', () => {
  // Feature: healthomics-workflow-dashboard, Property 7: Monotonic (idempotent)
  // upsert. For any set of upserts targeting the same run key applied in any
  // order, the final stored item equals the upsert with the greatest
  // updatedAt; any upsert whose updatedAt is <= the stored value leaves every
  // stored attribute unchanged. Re-applying an already-stored upsert is a
  // no-op (idempotent).
  // Validates: Requirements 3.8
  it('final stored run equals the upsert with the greatest updatedAt, regardless of order', async () => {
    const isoAt = (ms: number): string => new Date(ms).toISOString();

    await fc.assert(
      fc.asyncProperty(
        // Distinct millisecond timestamps so there is an unambiguous max.
        fc
          .uniqueArray(fc.integer({ min: 0, max: 4_000_000_000_000 }), {
            minLength: 1,
            maxLength: 12,
          })
          .chain((millis) =>
            fc.tuple(
              fc.constant(millis),
              // A distinguishing status per upsert so we can identify the winner.
              fc.array(fc.constantFrom(...Object.values(RunStatus)), {
                minLength: millis.length,
                maxLength: millis.length,
              }),
              fc.integer(), // shuffle seed
            ),
          ),
        async ([millis, statuses, seed]) => {
          const { repo, db } = makeRepo();

          const records: RunRecord[] = millis.map((ms, i) => ({
            runId: 'r-fixed',
            updatedAt: isoAt(ms),
            status: statuses[i],
          }));

          // Apply in a shuffled order derived from the seed.
          const order = [...records.keys()].sort(
            (a, b) => Math.sin(seed + a) - Math.sin(seed + b),
          );
          for (const idx of order) {
            await repo.upsertRun(records[idx]);
          }

          const maxMs = Math.max(...millis);
          const winner = records[millis.indexOf(maxMs)];
          const stored = db.store.get('RUN#r-fixed|RUN#r-fixed');

          expect(stored?.updatedAt).toBe(isoAt(maxMs));
          expect(stored?.status).toBe(winner.status);

          // Idempotency: re-applying the winning record is a preserved no-op.
          const before = { ...stored };
          const again = await repo.upsertRun(winner);
          expect(again.outcome).toBe('preserved');
          expect(db.store.get('RUN#r-fixed|RUN#r-fixed')).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('DynamoRepository - invalid identifier rejection (property)', () => {
  // Feature: healthomics-workflow-dashboard, Property 8: Invalid identifier
  // rejects the write. For any run record with an absent/empty runId, or task
  // record with an absent/empty runId or taskId, the upsert is rejected, the
  // store remains unchanged, and an error identifying the missing attribute is
  // emitted.
  // Validates: Requirements 3.9
  const emptyIsh = fc.constantFrom('', ' ', '   ', '\t', '\n', '  \t ');

  it('rejects run upserts with an empty/whitespace runId and leaves the store unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(emptyIsh, fc.string(), async (runId, updatedAt) => {
        const { repo, db } = makeRepo();
        const err = await repo.upsertRun({ runId, updatedAt }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidIdentifierError);
        expect((err as InvalidIdentifierError).attribute).toBe('runId');
        expect(db.sendCount).toBe(0);
        expect(db.store.size).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects task upserts with an empty/whitespace runId or taskId, naming the missing attribute', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => s.trim() !== ''),
        emptyIsh,
        fc.boolean(),
        fc.string(),
        async (validId, badId, emptyRunId, updatedAt) => {
          const { repo, db } = makeRepo();
          const record: TaskRecord = emptyRunId
            ? { runId: badId, taskId: validId, updatedAt }
            : { runId: validId, taskId: badId, updatedAt };

          const err = await repo.upsertTask(record).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(InvalidIdentifierError);
          expect((err as InvalidIdentifierError).attribute).toBe(emptyRunId ? 'runId' : 'taskId');
          expect(db.sendCount).toBe(0);
          expect(db.store.size).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * In-memory DynamoDB document-client double for the static-graph methods.
 *
 * Unlike `InMemoryDocClient` (which only understands the repository's guarded
 * `PutCommand`), this double evaluates the three command shapes the static-graph
 * methods issue: an unconditional `PutCommand` (putStaticGraph), a `GetCommand`
 * (getStaticGraph), and a `SET`-only `UpdateCommand` (recordGraphFailure). It
 * stores items keyed by `PK|SK` and implements Update as a merge that only
 * assigns the attributes named in the `SET` expression, so it faithfully models
 * the "preserve existing data on failure" semantics (Req 6.2, 7.1) rather than
 * rubber-stamping success.
 */
class InMemoryGraphDocClient {
  readonly store = new Map<string, Record<string, unknown>>();
  putCount = 0;
  getCount = 0;
  updateCount = 0;

  private keyOf(key: Record<string, unknown>): string {
    return `${String(key.PK)}|${String(key.SK)}`;
  }

  async send(
    command: PutCommand | GetCommand | UpdateCommand,
  ): Promise<unknown> {
    if (command instanceof PutCommand) {
      this.putCount += 1;
      const item = command.input.Item as Record<string, unknown>;
      this.store.set(`${String(item.PK)}|${String(item.SK)}`, { ...item });
      return {};
    }

    if (command instanceof GetCommand) {
      this.getCount += 1;
      const key = this.keyOf(command.input.Key as Record<string, unknown>);
      const existing = this.store.get(key);
      return { Item: existing ? { ...existing } : undefined };
    }

    if (command instanceof UpdateCommand) {
      this.updateCount += 1;
      const input = command.input;
      const key = this.keyOf(input.Key as Record<string, unknown>);
      const existing = this.store.get(key) ?? {
        ...(input.Key as Record<string, unknown>),
      };

      // Parse the "SET #a = :x, #b = :y" expression and apply only those
      // attributes, leaving all other stored attributes (e.g. nodes/edges)
      // untouched.
      const names = input.ExpressionAttributeNames ?? {};
      const values = input.ExpressionAttributeValues ?? {};
      const setClause = (input.UpdateExpression ?? '').replace(/^SET\s+/i, '');
      const merged = { ...existing };
      for (const assignment of setClause.split(',')) {
        const [lhs, rhs] = assignment.split('=').map((s) => s.trim());
        const attrName = names[lhs] ?? lhs;
        merged[attrName] = values[rhs];
      }
      this.store.set(key, merged);
      return {};
    }

    throw new Error('Unsupported command in InMemoryGraphDocClient');
  }

  asDocClient(): DynamoDBDocumentClient {
    return this as unknown as DynamoDBDocumentClient;
  }
}

function makeGraphRepo(): {
  repo: DynamoRepository;
  db: InMemoryGraphDocClient;
} {
  const db = new InMemoryGraphDocClient();
  const repo = new DynamoRepository(db.asDocClient(), TABLE);
  return { repo, db };
}

// The version name used across the graph repository tests. Keys are now
// version-qualified as `WF#<workflowId>#<workflowVersionName>` (Req 5.1).
const VER = 'v1';

const SAMPLE_GRAPH: StaticGraph = {
  workflowId: 'wf-1',
  nodes: [
    { id: 'a', name: 'align' },
    { id: 'b', name: 'call-variants' },
  ],
  edges: [{ from: 'a', to: 'b' }],
  fidelity: 'exact',
};

describe('graphPk / graphSk', () => {
  it('derives graph PK and SK as WF#<workflowId>#<workflowVersionName>', () => {
    expect(graphPk('wf-1', 'v1')).toBe('WF#wf-1#v1');
    expect(graphSk('wf-1', 'v1')).toBe('WF#wf-1#v1');
  });

  it('keeps graph PK === SK for the same workflow version (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (workflowId, versionName) => {
          expect(graphPk(workflowId, versionName)).toBe(
            graphSk(workflowId, versionName),
          );
        },
      ),
    );
  });
});

describe('buildGraphItem', () => {
  it('builds a graph item with version key, nodes, edges, fidelity, updatedAt, and entityType', () => {
    const item = buildGraphItem(
      'wf-1',
      VER,
      SAMPLE_GRAPH,
      '2024-01-01T00:00:00.000Z',
      'WDL',
    );
    expect(item).toEqual({
      PK: 'WF#wf-1#v1',
      SK: 'WF#wf-1#v1',
      workflowId: 'wf-1',
      workflowVersionName: 'v1',
      nodes: [
        { id: 'a', name: 'align' },
        { id: 'b', name: 'call-variants' },
      ],
      edges: [{ from: 'a', to: 'b' }],
      fidelity: 'exact',
      language: 'WDL',
      updatedAt: '2024-01-01T00:00:00.000Z',
      entityType: 'GRAPH',
    });
  });

  it('omits language when not provided and does not alias the source graph', () => {
    const item = buildGraphItem('wf-2', VER, SAMPLE_GRAPH, '2024-01-01T00:00:00.000Z');
    expect('language' in item).toBe(false);
    expect(item.fidelity).toBe('exact');
    expect(item.nodes).not.toBe(SAMPLE_GRAPH.nodes);
    expect(item.edges).not.toBe(SAMPLE_GRAPH.edges);
  });
});

describe('DynamoRepository.putStaticGraph / getStaticGraph (Req 5.1, 5.3-5.6)', () => {
  it('persists a graph under the version key and reads it back as a StaticGraph', async () => {
    const { repo, db } = makeGraphRepo();
    await repo.putStaticGraph('wf-1', VER, SAMPLE_GRAPH, 'WDL');

    const stored = db.store.get('WF#wf-1#v1|WF#wf-1#v1');
    expect(stored?.entityType).toBe('GRAPH');
    expect(stored?.workflowId).toBe('wf-1');
    expect(stored?.workflowVersionName).toBe('v1');
    expect(stored?.fidelity).toBe('exact');
    expect(stored?.language).toBe('WDL');

    const loaded = await repo.getStaticGraph('wf-1', VER);
    expect(loaded).toEqual(SAMPLE_GRAPH);
  });

  it('returns null when no graph is cached for the workflow version (Req 5.4)', async () => {
    const { repo } = makeGraphRepo();
    expect(await repo.getStaticGraph('missing', VER)).toBeNull();
  });

  it('isolates graphs across distinct version names (Req 5.8)', async () => {
    const { repo } = makeGraphRepo();
    await repo.putStaticGraph('wf-1', 'v1', SAMPLE_GRAPH);

    const v2Graph: StaticGraph = {
      workflowId: 'wf-1',
      nodes: [{ id: 'x', name: 'only' }],
      edges: [],
      fidelity: 'approximate',
    };
    await repo.putStaticGraph('wf-1', 'v2', v2Graph);

    // Each version's stored graph is readable and unaffected by the other.
    expect(await repo.getStaticGraph('wf-1', 'v1')).toEqual(SAMPLE_GRAPH);
    expect(await repo.getStaticGraph('wf-1', 'v2')).toEqual(v2Graph);
  });

  it('overwrites a prior graph on a subsequent put under the same version', async () => {
    const { repo } = makeGraphRepo();
    await repo.putStaticGraph('wf-1', VER, SAMPLE_GRAPH);

    const updated: StaticGraph = {
      workflowId: 'wf-1',
      nodes: [{ id: 'x', name: 'only' }],
      edges: [],
      fidelity: 'approximate',
    };
    await repo.putStaticGraph('wf-1', VER, updated);

    expect(await repo.getStaticGraph('wf-1', VER)).toEqual(updated);
  });

  it('round-trips arbitrary acyclic-shaped graphs and their fidelity (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.array(
          fc.record({ id: fc.string({ minLength: 1 }), name: fc.string() }),
          { maxLength: 8 },
        ),
        fc.constantFrom<'exact' | 'approximate'>('exact', 'approximate'),
        async (workflowId, versionName, nodes, fidelity) => {
          const { repo } = makeGraphRepo();
          const graph: StaticGraph = {
            workflowId,
            nodes,
            edges: [],
            fidelity,
          };
          await repo.putStaticGraph(workflowId, versionName, graph);
          const loaded = await repo.getStaticGraph(workflowId, versionName);
          expect(loaded).toEqual(graph);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('DynamoRepository.recordGraphFailure (Req 5.7)', () => {
  it('records a failureReason on an existing graph without clobbering nodes/edges/fidelity', async () => {
    const { repo, db } = makeGraphRepo();
    await repo.putStaticGraph('wf-1', VER, SAMPLE_GRAPH);

    await repo.recordGraphFailure('wf-1', VER, 'GetWorkflow timed out');

    const stored = db.store.get('WF#wf-1#v1|WF#wf-1#v1');
    // Failure reason recorded.
    expect(stored?.failureReason).toBe('GetWorkflow timed out');
    expect(stored?.workflowVersionName).toBe('v1');
    // Existing graph data preserved unchanged (Req 5.7).
    expect(stored?.nodes).toEqual(SAMPLE_GRAPH.nodes);
    expect(stored?.edges).toEqual(SAMPLE_GRAPH.edges);
    expect(stored?.fidelity).toBe('exact');

    // The cached graph is still readable after the failure is recorded.
    expect(await repo.getStaticGraph('wf-1', VER)).toEqual(SAMPLE_GRAPH);
  });

  it('creates a failure-only marker when no graph exists yet', async () => {
    const { repo, db } = makeGraphRepo();
    await repo.recordGraphFailure('wf-none', VER, 'unsupported language');

    const stored = db.store.get('WF#wf-none#v1|WF#wf-none#v1');
    expect(stored?.failureReason).toBe('unsupported language');
    expect(stored?.entityType).toBe('GRAPH');
    expect(stored?.workflowId).toBe('wf-none');
    expect(stored?.workflowVersionName).toBe('v1');
    // No graph data present, so getStaticGraph reports no usable cached graph.
    expect(await repo.getStaticGraph('wf-none', VER)).toBeNull();
  });

  it('preserves the cached graph across repeated failures (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
        async (reasons) => {
          const { repo } = makeGraphRepo();
          await repo.putStaticGraph('wf-1', VER, SAMPLE_GRAPH);
          for (const reason of reasons) {
            await repo.recordGraphFailure('wf-1', VER, reason);
          }
          // The graph data survives any number of recorded failures (Req 5.7).
          expect(await repo.getStaticGraph('wf-1', VER)).toEqual(SAMPLE_GRAPH);
        },
      ),
      { numRuns: 100 },
    );
  });
});
