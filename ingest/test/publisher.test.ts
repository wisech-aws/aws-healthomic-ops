import { describe, it, expect, vi } from 'vitest';

import {
  AppSyncPublisher,
  InvalidPublishIdentifierError,
  PublishFailedError,
  toRunInput,
  toTaskInput,
  type HttpTransport,
} from '../src/publisher.js';
import { RunStatus, TaskStatus } from '../src/domain/status.js';
import type { RunRecord, TaskRecord } from '../src/domain/records.js';

/**
 * Static, dummy IAM credentials so SigV4 signing has something to sign with
 * without reaching for the real Node credential provider chain in tests.
 */
const credentials = async () => ({
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secretExampleKey',
});

const ENDPOINT = 'https://example123.appsync-api.us-east-1.amazonaws.com/graphql';
const REGION = 'us-east-1';

/** The parsed GraphQL POST body the publisher sends. */
interface GraphQLBody {
  query: string;
  variables: { input: Record<string, unknown> };
}

/**
 * A recording HTTP transport double. It captures every request (url, headers,
 * parsed body) so tests can assert the dispatched mutation, and returns a
 * configurable response. `fail` forces a rejected send to exercise retries.
 */
function makeTransport(
  behavior: {
    fail?: boolean;
    status?: number;
    responseBody?: string;
  } = {},
): {
  transport: HttpTransport;
  calls: Array<{ url: string; headers: Record<string, string>; body: GraphQLBody }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: GraphQLBody }> = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (behavior.fail) {
      throw new Error('network down');
    }
    const status = behavior.status ?? 200;
    const text = behavior.responseBody ?? JSON.stringify({ data: {} });
    return { status, text: async () => text };
  };
  return { transport, calls };
}

function makePublisher(transport: HttpTransport, overrides = {}): AppSyncPublisher {
  return new AppSyncPublisher({
    endpoint: ENDPOINT,
    region: REGION,
    credentials,
    transport,
    logger: () => undefined,
    ...overrides,
  });
}

const runRecord: RunRecord = {
  runId: 'run-1',
  status: RunStatus.RUNNING,
  name: 'my run',
  updatedAt: '2024-01-01T00:00:00.000Z',
  workflowId: 'wf-1',
};

const taskRecord: TaskRecord = {
  runId: 'run-1',
  taskId: 'task-1',
  status: TaskStatus.COMPLETED,
  name: 'align',
  updatedAt: '2024-01-01T00:05:00.000Z',
  cpus: 4,
  memory: 8,
};

describe('toRunInput / toTaskInput', () => {
  it('maps a RunRecord to RunInput, omitting absent optional fields', () => {
    expect(toRunInput(runRecord)).toEqual({
      runId: 'run-1',
      status: 'RUNNING',
      name: 'my run',
      updatedAt: '2024-01-01T00:00:00.000Z',
      workflowId: 'wf-1',
    });
  });

  it('maps a TaskRecord to TaskInput including numeric fields', () => {
    expect(toTaskInput(taskRecord)).toEqual({
      runId: 'run-1',
      taskId: 'task-1',
      status: 'COMPLETED',
      name: 'align',
      updatedAt: '2024-01-01T00:05:00.000Z',
      cpus: 4,
      memory: 8,
    });
  });

  it('maps statusMessage/failureReason for a failed RunRecord', () => {
    const failedRun: RunRecord = {
      ...runRecord,
      status: RunStatus.FAILED,
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
      failureReason: 'WORKFLOW_RUN_FAILED',
    };
    expect(toRunInput(failedRun)).toMatchObject({
      statusMessage: 'Workflow run failed. Review the CloudWatch logs...',
      failureReason: 'WORKFLOW_RUN_FAILED',
    });
  });

  it('maps statusMessage/failureReason for a failed TaskRecord', () => {
    const failedTask: TaskRecord = {
      ...taskRecord,
      status: TaskStatus.FAILED,
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    };
    expect(toTaskInput(failedTask)).toMatchObject({
      statusMessage: 'Run failed due to task: ... failure.',
      failureReason: 'RUN_TASK_FAILED',
    });
  });
});

describe('AppSyncPublisher constructor', () => {
  it('throws when no endpoint is available', () => {
    expect(
      () => new AppSyncPublisher({ region: REGION, credentials, endpoint: '' }),
    ).toThrow(/endpoint/);
  });

  it('throws when no region is available', () => {
    expect(
      () => new AppSyncPublisher({ endpoint: ENDPOINT, credentials, region: '' }),
    ).toThrow(/region/);
  });
});

describe('AppSyncPublisher.publishRunUpdate', () => {
  it('dispatches the publishRunUpdate mutation with the run input and a SigV4 Authorization header', async () => {
    const { transport, calls } = makeTransport();
    const publisher = makePublisher(transport);

    const result = await publisher.publishRunUpdate(runRecord);

    expect(result).toEqual({ outcome: 'published' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT);
    // The mutation targets publishRunUpdate and carries the mapped input.
    expect(calls[0].body.query).toContain('publishRunUpdate');
    expect(calls[0].body.variables.input).toEqual(toRunInput(runRecord));
    // IAM auth: SigV4 signing adds an Authorization header (Req 4.3).
    const authHeader = calls[0].headers['authorization'] ?? calls[0].headers['Authorization'];
    expect(authHeader).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('rejects a run with a missing identifier without calling the mutation (Req 4.9)', async () => {
    const { transport, calls } = makeTransport();
    const publisher = makePublisher(transport);

    const result = await publisher.publishRunUpdate({
      ...runRecord,
      runId: '',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.error).toBeInstanceOf(InvalidPublishIdentifierError);
      expect(result.error.attribute).toBe('runId');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects a run whose identifier is whitespace-only', async () => {
    const { transport, calls } = makeTransport();
    const publisher = makePublisher(transport);

    const result = await publisher.publishRunUpdate({ ...runRecord, runId: '   ' });

    expect(result.outcome).toBe('rejected');
    expect(calls).toHaveLength(0);
  });

  it('retries up to 3 attempts then records a failure without throwing, retaining persisted data (Req 4.8)', async () => {
    const { transport, calls } = makeTransport({ fail: true });
    const publisher = makePublisher(transport);

    const result = await publisher.publishRunUpdate(runRecord);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.error).toBeInstanceOf(PublishFailedError);
      expect(result.error.mutation).toBe('publishRunUpdate');
      expect(result.error.identifier).toBe('run-1');
    }
    // Three total attempts (initial + 2 retries).
    expect(calls).toHaveLength(3);
  });

  it('treats a GraphQL errors array as a failure and retries', async () => {
    const { transport, calls } = makeTransport({
      status: 200,
      responseBody: JSON.stringify({ errors: [{ message: 'boom' }] }),
    });
    const publisher = makePublisher(transport);

    const result = await publisher.publishRunUpdate(runRecord);

    expect(result.outcome).toBe('failed');
    expect(calls).toHaveLength(3);
  });

  it('treats a non-2xx status as a failure and retries', async () => {
    const { transport, calls } = makeTransport({ status: 500 });
    const publisher = makePublisher(transport);

    const result = await publisher.publishRunUpdate(runRecord);

    expect(result.outcome).toBe('failed');
    expect(calls).toHaveLength(3);
  });

  it('succeeds on a later attempt after transient failures', async () => {
    let attempt = 0;
    const calls: GraphQLBody[] = [];
    const transport: HttpTransport = async (_url, init) => {
      calls.push(JSON.parse(init.body));
      attempt += 1;
      if (attempt < 2) {
        throw new Error('transient');
      }
      return { status: 200, text: async () => JSON.stringify({ data: {} }) };
    };
    const publisher = makePublisher(transport);

    const result = await publisher.publishRunUpdate(runRecord);

    expect(result).toEqual({ outcome: 'published' });
    expect(calls).toHaveLength(2);
  });
});

describe('AppSyncPublisher.publishTaskUpdate', () => {
  it('dispatches the publishTaskUpdate mutation with the task input', async () => {
    const { transport, calls } = makeTransport();
    const publisher = makePublisher(transport);

    const result = await publisher.publishTaskUpdate(taskRecord);

    expect(result).toEqual({ outcome: 'published' });
    expect(calls[0].body.query).toContain('publishTaskUpdate');
    expect(calls[0].body.variables.input).toEqual(toTaskInput(taskRecord));
  });

  it('rejects a task with a missing runId without calling the mutation (Req 4.9)', async () => {
    const { transport, calls } = makeTransport();
    const publisher = makePublisher(transport);

    const result = await publisher.publishTaskUpdate({ ...taskRecord, runId: '' });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.error.attribute).toBe('runId');
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects a task with a missing taskId without calling the mutation (Req 4.9)', async () => {
    const { transport, calls } = makeTransport();
    const publisher = makePublisher(transport);

    const result = await publisher.publishTaskUpdate({ ...taskRecord, taskId: '' });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.error.attribute).toBe('taskId');
    }
    expect(calls).toHaveLength(0);
  });

  it('records the run/task identifier in the publish failure (Req 4.8)', async () => {
    const { transport } = makeTransport({ fail: true });
    const publisher = makePublisher(transport);

    const result = await publisher.publishTaskUpdate(taskRecord);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.error.identifier).toBe('run-1/task-1');
    }
  });

  it('logs the invalid identifier when rejecting', async () => {
    const logger = vi.fn();
    const { transport } = makeTransport();
    const publisher = makePublisher(transport, { logger });

    await publisher.publishTaskUpdate({ ...taskRecord, taskId: '' });

    const messages = logger.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('taskId'))).toBe(true);
  });
});
