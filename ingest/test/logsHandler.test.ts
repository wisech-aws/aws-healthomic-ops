import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the CloudWatch Logs client so tests never hit AWS. `vi.mock` is hoisted
// above module code, so the shared mock refs must be created via `vi.hoisted`.
const { sendMock, capturedInputs } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  capturedInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@aws-sdk/client-cloudwatch-logs', () => {
  class CloudWatchLogsClient {
    send = sendMock;
  }
  class GetLogEventsCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
      capturedInputs.push(input);
    }
  }
  class ResourceNotFoundException extends Error {
    constructor() {
      super('not found');
      this.name = 'ResourceNotFoundException';
    }
  }
  return { CloudWatchLogsClient, GetLogEventsCommand, ResourceNotFoundException };
});

import { handler, errorExcerptHandler, router } from '../src/logsHandler.js';
import { ResourceNotFoundException } from '@aws-sdk/client-cloudwatch-logs';

function makeEvent(args: Record<string, unknown>) {
  return { arguments: args } as never;
}

describe('logsHandler getRunLogs', () => {
  beforeEach(() => {
    sendMock.mockReset();
    capturedInputs.length = 0;
  });

  it('derives the RUN stream name run/<id>', async () => {
    sendMock.mockResolvedValue({ events: [], nextForwardToken: 'tok' });
    const res = await handler(makeEvent({ runId: 'r1', stream: 'RUN' }));
    expect(capturedInputs[0].logStreamName).toBe('run/r1');
    expect(res.logStreamName).toBe('run/r1');
    expect(res.nextToken).toBe('tok');
  });

  it('derives the ENGINE stream name run/<id>/engine', async () => {
    sendMock.mockResolvedValue({ events: [], nextForwardToken: null });
    await handler(makeEvent({ runId: 'r1', stream: 'ENGINE' }));
    expect(capturedInputs[0].logStreamName).toBe('run/r1/engine');
  });

  it('derives the TASK stream name run/<id>/task/<taskId>', async () => {
    sendMock.mockResolvedValue({ events: [], nextForwardToken: null });
    await handler(makeEvent({ runId: 'r1', stream: 'TASK', taskId: 't9' }));
    expect(capturedInputs[0].logStreamName).toBe('run/r1/task/t9');
  });

  it('maps returned events to {timestamp, message}', async () => {
    sendMock.mockResolvedValue({
      events: [
        { timestamp: 111, message: 'staging genome.fasta' },
        { timestamp: 222, message: 'submitted process FASTQC' },
      ],
      nextForwardToken: 'next',
    });
    const res = await handler(makeEvent({ runId: 'r1', stream: 'ENGINE' }));
    expect(res.events).toEqual([
      { timestamp: 111, message: 'staging genome.fasta' },
      { timestamp: 222, message: 'submitted process FASTQC' },
    ]);
  });

  it('returns an empty page (not an error) when the stream does not exist yet', async () => {
    sendMock.mockRejectedValue(new ResourceNotFoundException());
    const res = await handler(makeEvent({ runId: 'r1', stream: 'TASK', taskId: 't-new' }));
    expect(res.events).toEqual([]);
    expect(res.nextToken).toBeNull();
    expect(res.logStreamName).toBe('run/r1/task/t-new');
  });

  it('rejects a TASK request with no taskId', async () => {
    await expect(handler(makeEvent({ runId: 'r1', stream: 'TASK' }))).rejects.toThrow(
      /taskId is required/i,
    );
  });

  it('rejects a missing runId', async () => {
    await expect(handler(makeEvent({ runId: '', stream: 'RUN' }))).rejects.toThrow(
      /runId is required/i,
    );
  });

  it('clamps limit to the 1..1000 range (default 200)', async () => {
    sendMock.mockResolvedValue({ events: [], nextForwardToken: null });
    await handler(makeEvent({ runId: 'r1', stream: 'RUN', limit: 99999 }));
    expect(capturedInputs[0].limit).toBe(1000);
    capturedInputs.length = 0;
    await handler(makeEvent({ runId: 'r1', stream: 'RUN' }));
    expect(capturedInputs[0].limit).toBe(200);
  });
});

describe('logsHandler errorExcerptHandler (getErrorExcerpt)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    capturedInputs.length = 0;
  });

  it('extracts the error excerpt from a single-page stream', async () => {
    sendMock.mockResolvedValue({
      events: [
        { timestamp: 1, message: 'Task started' },
        { timestamp: 2, message: '[ERROR] We failed to reach a server.' },
        { timestamp: 3, message: '[ERROR] Reason: [Errno 110] Connection timed out' },
        { timestamp: 4, message: 'Task failed' },
      ],
      nextForwardToken: 'tok-1',
    });
    const result = await errorExcerptHandler(
      makeEvent({ runId: 'r1', stream: 'TASK', taskId: 't1' }),
    );
    expect(result).toEqual({
      found: true,
      truncated: false,
      lines: [
        '[ERROR] We failed to reach a server.',
        '[ERROR] Reason: [Errno 110] Connection timed out',
        'Task failed',
      ],
    });
    expect(capturedInputs[0].logStreamName).toBe('run/r1/task/t1');
  });

  it('pages through multiple GetLogEvents calls to scan the whole stream', async () => {
    // First page returns a fresh token; second page echoes it back, signaling
    // "no more pages" (matching real CloudWatch stream-end semantics).
    sendMock
      .mockResolvedValueOnce({
        events: [{ timestamp: 1, message: 'benign line 1' }],
        nextForwardToken: 'tok-a',
      })
      .mockResolvedValueOnce({
        events: [{ timestamp: 2, message: 'nextflow.SomeException: real cause' }],
        nextForwardToken: 'tok-a',
      });

    const result = await errorExcerptHandler(makeEvent({ runId: 'r1', stream: 'ENGINE' }));
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(true);
    expect(result.lines).toEqual(['nextflow.SomeException: real cause']);
  });

  it('returns found:false (never a fabricated excerpt) when the stream has no error lines', async () => {
    sendMock.mockResolvedValue({
      events: [
        { timestamp: 1, message: 'Task started' },
        { timestamp: 2, message: 'Task completed' },
      ],
      nextForwardToken: null,
    });
    const result = await errorExcerptHandler(makeEvent({ runId: 'r1', stream: 'RUN' }));
    expect(result).toEqual({ found: false, lines: [], truncated: false });
  });

  it('returns found:false (not an error) when the stream does not exist yet', async () => {
    sendMock.mockRejectedValue(new ResourceNotFoundException());
    const result = await errorExcerptHandler(
      makeEvent({ runId: 'r1', stream: 'TASK', taskId: 't-new' }),
    );
    expect(result).toEqual({ found: false, lines: [], truncated: false });
  });

  it('rejects a missing runId', async () => {
    await expect(
      errorExcerptHandler(makeEvent({ runId: '', stream: 'RUN' })),
    ).rejects.toThrow(/runId is required/i);
  });

  it('rejects a TASK request with no taskId', async () => {
    await expect(
      errorExcerptHandler(makeEvent({ runId: 'r1', stream: 'TASK' })),
    ).rejects.toThrow(/taskId is required/i);
  });

  it('propagates a non-ResourceNotFoundException error', async () => {
    sendMock.mockRejectedValue(new Error('service unavailable'));
    await expect(
      errorExcerptHandler(makeEvent({ runId: 'r1', stream: 'RUN' })),
    ).rejects.toThrow(/service unavailable/);
  });
});

describe('logsHandler router (direct Lambda resolver dispatch)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    capturedInputs.length = 0;
  });

  it('dispatches to errorExcerptHandler when info.fieldName is "getErrorExcerpt"', async () => {
    sendMock.mockResolvedValue({
      events: [{ timestamp: 1, message: '[ERROR] boom' }],
      nextForwardToken: null,
    });
    const result = await router({
      arguments: { runId: 'r1', stream: 'RUN' },
      info: { fieldName: 'getErrorExcerpt' },
    });
    expect(result).toEqual({ found: true, truncated: false, lines: ['[ERROR] boom'] });
  });

  it('dispatches to the getRunLogs handler when info.fieldName is "getRunLogs"', async () => {
    sendMock.mockResolvedValue({ events: [], nextForwardToken: 'tok' });
    const result = await router({
      arguments: { runId: 'r1', stream: 'RUN' },
      info: { fieldName: 'getRunLogs' },
    });
    expect(result).toEqual({ logStreamName: 'run/r1', events: [], nextToken: 'tok' });
  });

  it('defaults to the getRunLogs handler when info is absent (back-compat with the pre-existing direct-invoke shape)', async () => {
    sendMock.mockResolvedValue({ events: [], nextForwardToken: null });
    const result = await router({ arguments: { runId: 'r1', stream: 'RUN' } });
    expect(result).toEqual({ logStreamName: 'run/r1', events: [], nextToken: null });
  });
});
