import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import type { EventBridgeEvent } from 'aws-lambda';
import { detectKind, mapRunEvent, mapTaskEvent } from '../src/eventMapper.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import { runEvents, taskEvents, taskLifecycle } from './fixtures/events.js';

/**
 * Build a minimal EventBridge envelope around a given `detail-type` and
 * `detail`. Mirrors the real HealthOmics event shape confirmed against AWS docs
 * (see eventMapper.ts "CONFIRM AGAINST AWS DOCS" constants).
 */
function makeEvent(
  detailType: string,
  detail: unknown,
): EventBridgeEvent<string, unknown> {
  return {
    version: '0',
    id: 'c0e540f4-df38-b986-86c1-3e3730f971fe',
    'detail-type': detailType,
    source: 'aws.omics',
    account: '123456789012',
    time: '2022-10-20T22:07:35Z',
    region: 'us-west-2',
    resources: ['arn:aws:omics:us-west-2:123456789012:run/2101313'],
    detail,
  };
}

// A complete run "Run Status Change" detail, per the AWS example.
const FULL_RUN_DETAIL = {
  omicsVersion: '1.0.0',
  arn: 'arn:aws:omics:us-west-2:123456789012:run/2101313',
  status: 'COMPLETED',
  uuid: '153893cd-097a-40ec-aec7-838a97cd2b21',
  runId: '1234567',
  runName: 'run name',
  runOutputUri: 's3://amzn-s3-demo-bucket/run-output/2101313',
  workflowId: '7654321',
  workflowName: 'workflow name',
};

// A complete task "Task Status Change" detail, per the AWS example. Note the
// task id lives only in the task `arn`.
const FULL_TASK_DETAIL = {
  omicsVersion: '1.0.0',
  arn: 'arn:aws:omics:us-west-2:123456789012:task/8888888',
  status: 'COMPLETED',
  runArn: 'arn:aws:omics:us-west-2:123456789012:run/2101313',
  runUuid: '153893cd-097a-40ec-aec7-838a97cd2b21',
  runId: '1234567',
  runName: 'run name',
  name: 'align',
  workflowId: '7654321',
  workflowName: 'workflow name',
};

describe('detectKind', () => {
  it('classifies a Run Status Change event as RUN', () => {
    expect(detectKind(makeEvent('Run Status Change', FULL_RUN_DETAIL))).toBe(
      'RUN',
    );
  });

  it('classifies a Task Status Change event as TASK', () => {
    expect(detectKind(makeEvent('Task Status Change', FULL_TASK_DETAIL))).toBe(
      'TASK',
    );
  });

  it('classifies any other detail-type as UNKNOWN', () => {
    expect(
      detectKind(makeEvent('Read Set Status Change', { status: 'ACTIVE' })),
    ).toBe('UNKNOWN');
    expect(detectKind(makeEvent('', {}))).toBe('UNKNOWN');
  });
});

describe('mapRunEvent', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('extracts all present fields from a valid run event (Req 1.3)', () => {
    const result = mapRunEvent(makeEvent('Run Status Change', FULL_RUN_DETAIL));
    expect(result).toEqual({
      runId: '1234567',
      status: RunStatus.COMPLETED,
      name: 'run name',
      workflowId: '7654321',
      workflowName: 'workflow name',
      outputUri: 's3://amzn-s3-demo-bucket/run-output/2101313',
    });
  });

  it('does not set createdAt/startedAt/stoppedAt (enrichment fields)', () => {
    const result = mapRunEvent(makeEvent('Run Status Change', FULL_RUN_DETAIL));
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('startedAt');
    expect(result).not.toHaveProperty('stoppedAt');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('omits missing fields and logs the full event without throwing (Req 1.5)', () => {
    const result = mapRunEvent(
      makeEvent('Run Status Change', { status: 'RUNNING' }),
    );
    expect(result).toEqual({ status: RunStatus.RUNNING });
    expect(result).not.toHaveProperty('runId');
    expect(logSpy).toHaveBeenCalled();
  });

  it('skips an out-of-enum status but keeps other fields (Req 1.6)', () => {
    const result = mapRunEvent(
      makeEvent('Run Status Change', {
        ...FULL_RUN_DETAIL,
        status: 'BOGUS_STATUS',
      }),
    );
    expect(result).not.toHaveProperty('status');
    expect(result.runId).toBe('1234567');
    expect(result.workflowId).toBe('7654321');
    expect(logSpy).toHaveBeenCalled();
  });

  it('treats a completely empty detail defensively', () => {
    expect(() => mapRunEvent(makeEvent('Run Status Change', {}))).not.toThrow();
    expect(mapRunEvent(makeEvent('Run Status Change', {}))).toEqual({});
  });

  it('treats a null/non-object detail defensively', () => {
    expect(mapRunEvent(makeEvent('Run Status Change', null))).toEqual({});
    expect(mapRunEvent(makeEvent('Run Status Change', 'not-an-object'))).toEqual(
      {},
    );
  });

  it('ignores empty-string field values', () => {
    const result = mapRunEvent(
      makeEvent('Run Status Change', { ...FULL_RUN_DETAIL, runId: '   ' }),
    );
    expect(result).not.toHaveProperty('runId');
  });
});

describe('mapTaskEvent', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('extracts all present fields including taskId from arn (Req 1.4)', () => {
    const result = mapTaskEvent(
      makeEvent('Task Status Change', FULL_TASK_DETAIL),
    );
    expect(result).toEqual({
      runId: '1234567',
      taskId: '8888888',
      status: TaskStatus.COMPLETED,
      name: 'align',
    });
  });

  it('does not set cpus/memory/timestamps (enrichment fields)', () => {
    const result = mapTaskEvent(
      makeEvent('Task Status Change', FULL_TASK_DETAIL),
    );
    expect(result).not.toHaveProperty('cpus');
    expect(result).not.toHaveProperty('memory');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
  });

  it('omits taskId when arn is missing and logs (Req 1.5)', () => {
    const detailWithoutArn: Record<string, unknown> = { ...FULL_TASK_DETAIL };
    delete detailWithoutArn.arn;
    const result = mapTaskEvent(
      makeEvent('Task Status Change', detailWithoutArn),
    );
    expect(result).not.toHaveProperty('taskId');
    expect(result.runId).toBe('1234567');
    expect(logSpy).toHaveBeenCalled();
  });

  it('omits taskId when arn has no task/ segment', () => {
    const result = mapTaskEvent(
      makeEvent('Task Status Change', {
        ...FULL_TASK_DETAIL,
        arn: 'arn:aws:omics:us-west-2:123456789012:run/2101313',
      }),
    );
    expect(result).not.toHaveProperty('taskId');
  });

  it('skips an out-of-enum status but keeps other fields (Req 1.6)', () => {
    const result = mapTaskEvent(
      makeEvent('Task Status Change', {
        ...FULL_TASK_DETAIL,
        status: 'DELETED', // DELETED is a RunStatus but NOT a TaskStatus
      }),
    );
    expect(result).not.toHaveProperty('status');
    expect(result.taskId).toBe('8888888');
    expect(logSpy).toHaveBeenCalled();
  });

  it('treats a completely empty detail defensively', () => {
    expect(() =>
      mapTaskEvent(makeEvent('Task Status Change', {})),
    ).not.toThrow();
    expect(mapTaskEvent(makeEvent('Task Status Change', {}))).toEqual({});
  });
});

/**
 * Property 1: Event mapping robustness and extraction.
 *
 * For any HealthOmics run or task event, and for any subset of its `detail`
 * fields removed, the event mapper does not throw and returns exactly the
 * fields still present; a valid enum status is extracted, and a non-enum status
 * value is left unset rather than surfaced.
 *
 * **Validates: Requirements 1.3, 1.4, 1.5, 1.6**
 */
describe('Property 1: event mapping robustness and extraction', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never throws and only returns present run fields (Req 1.3, 1.5, 1.6)', () => {
    // Arbitrary status: sometimes a valid RunStatus, sometimes a bogus string.
    const statusArb = fc.oneof(
      fc.constantFrom(...Object.values(RunStatus)),
      fc.string(),
    );
    const detailArb = fc.record(
      {
        runId: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        status: statusArb,
        runName: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        workflowId: fc
          .string({ minLength: 1 })
          .filter((s) => s.trim().length > 0),
        workflowName: fc
          .string({ minLength: 1 })
          .filter((s) => s.trim().length > 0),
      },
      // Every key is independently optional → covers all removed-field subsets.
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(detailArb, (detail) => {
        const event = makeEvent('Run Status Change', detail);
        const result = mapRunEvent(event);

        // Present, non-empty fields are extracted exactly; absent fields omitted.
        if ('runId' in detail) {
          expect(result.runId).toBe(detail.runId);
        } else {
          expect(result).not.toHaveProperty('runId');
        }
        if ('runName' in detail) {
          expect(result.name).toBe(detail.runName);
        } else {
          expect(result).not.toHaveProperty('name');
        }

        // Status: extracted iff it is a valid enum member, else left unset.
        if ('status' in detail && Object.values(RunStatus).includes(detail.status as RunStatus)) {
          expect(result.status).toBe(detail.status);
        } else {
          expect(result).not.toHaveProperty('status');
        }
      }),
    );
  });

  it('never throws and only returns present task fields (Req 1.4, 1.5, 1.6)', () => {
    const statusArb = fc.oneof(
      fc.constantFrom(...Object.values(TaskStatus)),
      fc.string(),
    );
    const detailArb = fc.record(
      {
        runId: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        arn: fc
          .string({ minLength: 1 })
          .filter((s) => s.trim().length > 0)
          .map((s) => `arn:aws:omics:us-west-2:123456789012:task/${s}`),
        status: statusArb,
        name: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(detailArb, (detail) => {
        const event = makeEvent('Task Status Change', detail);
        const result = mapTaskEvent(event);

        if ('runId' in detail) {
          expect(result.runId).toBe(detail.runId);
        } else {
          expect(result).not.toHaveProperty('runId');
        }

        if ('status' in detail && Object.values(TaskStatus).includes(detail.status as TaskStatus)) {
          expect(result.status).toBe(detail.status);
        } else {
          expect(result).not.toHaveProperty('status');
        }

        // taskId is present iff the arn yielded a non-empty task segment.
        if ('taskId' in result) {
          expect(typeof result.taskId).toBe('string');
          expect((result.taskId as string).length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

/**
 * Real captured events from run 8508632 (omicsVersion 1.0.0): task events
 * carry taskName/cpus/gpus/memory/creationTime at every status, RUNNING adds
 * instanceType/startTime, COMPLETED adds stopTime. Values are strings.
 */
describe('mapping real captured HealthOmics events (run 8508632)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  const [pending, starting, running, completed] = taskLifecycle('9303953');

  it('PENDING maps taskName, numeric cpus/memory and createdAt, without logging', () => {
    expect(pending.detail.status).toBe('PENDING');
    const result = mapTaskEvent(pending);
    expect(result).toEqual({
      runId: '8508632',
      taskId: '9303953',
      status: TaskStatus.PENDING,
      name: 'NFCORE_RNASEQ:RNASEQ:FASTQ_QC_TRIM_FILTER_SETSTRANDEDNESS:FQ_LINT (WT_REP2)',
      cpus: 2,
      memory: 12,
      createdAt: '2026-11-03T22:41:30.523Z',
    });
    expect(typeof result.cpus).toBe('number');
    expect(result).not.toHaveProperty('instanceType');
    expect(result).not.toHaveProperty('startedAt');
    expect(result).not.toHaveProperty('stoppedAt');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('STARTING carries the same fields as PENDING', () => {
    const result = mapTaskEvent(starting);
    expect(result.status).toBe(TaskStatus.STARTING);
    expect(result.name).toBe(mapTaskEvent(pending).name);
    expect(result).not.toHaveProperty('startedAt');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('RUNNING adds instanceType and startedAt (from startTime, not event.time)', () => {
    const result = mapTaskEvent(running);
    expect(result.status).toBe(TaskStatus.RUNNING);
    expect(result.instanceType).toBe('omics.r.large');
    expect(result.startedAt).toBe('2026-11-03T22:52:31.275Z');
    expect(result).not.toHaveProperty('stoppedAt');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('COMPLETED adds stoppedAt with millisecond precision', () => {
    const result = mapTaskEvent(completed);
    expect(result).toMatchObject({
      status: TaskStatus.COMPLETED,
      instanceType: 'omics.r.large',
      createdAt: '2026-11-03T22:41:30.523Z',
      startedAt: '2026-11-03T22:52:31.275Z',
      stoppedAt: '2026-11-03T22:52:51.913Z',
      cpus: 2,
      memory: 12,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('never logs the full event for any captured task or run event', () => {
    for (const status of ['PENDING', 'STARTING', 'RUNNING', 'COMPLETED']) {
      for (const event of taskEvents(status)) {
        const result = mapTaskEvent(event);
        expect(result.name).toBeDefined();
        expect(result.cpus).toBeTypeOf('number');
        expect(result.memory).toBeTypeOf('number');
        expect(result.createdAt).toBeDefined();
      }
    }
    for (const event of runEvents()) {
      mapRunEvent(event);
    }
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('omits non-numeric or empty cpus/memory', () => {
    const result = mapTaskEvent({
      ...completed,
      detail: { ...completed.detail, cpus: 'abc', memory: '' },
    });
    expect(result).not.toHaveProperty('cpus');
    expect(result).not.toHaveProperty('memory');
    expect(result.name).toBeDefined();
  });

  it('omits an unparseable timestamp', () => {
    const result = mapTaskEvent({
      ...completed,
      detail: { ...completed.detail, stopTime: 'not-a-time' },
    });
    expect(result).not.toHaveProperty('stoppedAt');
  });

  it('still reads the legacy `name` field when taskName is absent', () => {
    const detail: Record<string, unknown> = { ...completed.detail, name: 'legacy' };
    delete detail.taskName;
    expect(mapTaskEvent({ ...completed, detail }).name).toBe('legacy');
  });

  it('maps workflowVersionName and runOutputUri on run events', () => {
    const [runPending] = runEvents();
    expect(mapRunEvent(runPending)).toEqual({
      runId: '8508632',
      status: RunStatus.PENDING,
      name: 'rnaseq-vpc-event-enrichment-20261103-1729',
      workflowId: '2897933',
      workflowName: 'nf-core-rnaseq',
      workflowVersionName: 'v2-wave-fix',
      outputUri:
        's3://healthomics-input-data-123456789012-us-east-1-an/run-outputs/dashboard-e2e-rnaseq/8508632',
    });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
