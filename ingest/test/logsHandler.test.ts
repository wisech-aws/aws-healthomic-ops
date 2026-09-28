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

  // Default (non-tail) path protection: WITHOUT `tail`, the successful-run log
  // retrieval MUST stay oldest-first (`startFromHead: true`) and return the
  // FORWARD token — asserted explicitly so a future tail change can't silently
  // regress it.
  it('without tail, fetches oldest-first (startFromHead:true) and returns the forward token', async () => {
    sendMock.mockResolvedValue({
      events: [{ timestamp: 1, message: 'line' }],
      nextForwardToken: 'fwd',
      nextBackwardToken: 'bwd',
    });
    const res = await handler(makeEvent({ runId: 'r1', stream: 'ENGINE' }));
    expect(capturedInputs[0].startFromHead).toBe(true);
    expect(res.nextToken).toBe('fwd');
  });

  it('with tail:false, also fetches oldest-first and returns the forward token', async () => {
    sendMock.mockResolvedValue({
      events: [],
      nextForwardToken: 'fwd',
      nextBackwardToken: 'bwd',
    });
    const res = await handler(makeEvent({ runId: 'r1', stream: 'RUN', tail: false }));
    expect(capturedInputs[0].startFromHead).toBe(true);
    expect(res.nextToken).toBe('fwd');
  });

  // Opt-in tail path (failed-run triage): with `tail:true`, fetch newest-first
  // (`startFromHead:false`) and return the BACKWARD token so the client pages
  // older on demand.
  it('with tail:true, fetches newest-first (startFromHead:false) and returns the backward token', async () => {
    sendMock.mockResolvedValue({
      events: [
        { timestamp: 111, message: 'earlier in slice' },
        { timestamp: 222, message: '[ERROR] boom at the end' },
      ],
      nextForwardToken: 'fwd',
      nextBackwardToken: 'bwd',
    });
    const res = await handler(makeEvent({ runId: 'r1', stream: 'ENGINE', tail: true }));
    expect(capturedInputs[0].startFromHead).toBe(false);
    expect(res.nextToken).toBe('bwd');
    // Events are surfaced in the ascending order CloudWatch returns them within
    // the page (not reversed), so the <pre> still reads oldest→newest.
    expect(res.events).toEqual([
      { timestamp: 111, message: 'earlier in slice' },
      { timestamp: 222, message: '[ERROR] boom at the end' },
    ]);
  });

  it('with tail:true, still returns an empty page (not an error) when the stream does not exist', async () => {
    sendMock.mockRejectedValue(new ResourceNotFoundException());
    const res = await handler(
      makeEvent({ runId: 'r1', stream: 'TASK', taskId: 't-new', tail: true }),
    );
    expect(res.events).toEqual([]);
    expect(res.nextToken).toBeNull();
    expect(res.logStreamName).toBe('run/r1/task/t-new');
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

  it('reads the stream tail newest-first (startFromHead:false) in one round-trip when the tail holds the error', async () => {
    sendMock.mockResolvedValue({
      events: [
        { timestamp: 1, message: 'benign line 1' },
        { timestamp: 2, message: 'nextflow.SomeException: real cause' },
      ],
      // No backward token → start-of-stream: the tail fetch stops after one call.
      nextBackwardToken: null,
    });

    const result = await errorExcerptHandler(makeEvent({ runId: 'r1', stream: 'ENGINE' }));
    // Tail-oriented extraction only needs the newest slice: one call, newest-first.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(capturedInputs[0].startFromHead).toBe(false);
    expect(result.found).toBe(true);
    expect(result.lines).toEqual(['nextflow.SomeException: real cause']);
  });

  it('walks OLDER via the backward token, prepending pages so the assembled lines stay oldest-first', async () => {
    // Newest page first (page 0), then an older page (page 1); a third call
    // echoes the same backward token to signal start-of-stream.
    sendMock
      .mockResolvedValueOnce({
        events: [{ timestamp: 3, message: '    at nextflow.Foo.bar(Foo.groovy:1)' }],
        nextBackwardToken: 'bwd-1',
      })
      .mockResolvedValueOnce({
        events: [{ timestamp: 2, message: 'nextflow.SomeException: real cause' }],
        nextBackwardToken: 'bwd-2',
      })
      .mockResolvedValueOnce({
        events: [{ timestamp: 1, message: 'benign earlier line' }],
        nextBackwardToken: 'bwd-2',
      });

    const result = await errorExcerptHandler(makeEvent({ runId: 'r1', stream: 'ENGINE' }));
    // Three pages: two with content + one that echoes the backward token (stop).
    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(capturedInputs[0].startFromHead).toBe(false);
    // Headline (from the older page) is returned through the trailing stack
    // frame (from the newer page) — proving pages were assembled oldest-first.
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
