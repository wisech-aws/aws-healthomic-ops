import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KinesisStreamEvent } from 'aws-lambda';

// The Kinesis consumer delegates to the shared production pipeline via
// getDefaultHandler(). Mock that so we can drive success/failure per record
// without building the whole environment-configured handler.
const pipeline = vi.fn(async (_event: unknown) => undefined);
vi.mock('../src/handler.js', () => ({
  getDefaultHandler: () => pipeline,
}));

import { handler } from '../src/kinesisHandler.js';

/** Build a Kinesis record whose data is the base64 of an EventBridge event. */
function kinesisRecord(seq: string, ebEvent: unknown) {
  return {
    kinesis: {
      sequenceNumber: seq,
      data: Buffer.from(JSON.stringify(ebEvent), 'utf8').toString('base64'),
      partitionKey: 'run-1',
      approximateArrivalTimestamp: 0,
      kinesisSchemaVersion: '1.0',
    },
    eventID: `shard:${seq}`,
    eventName: 'aws:kinesis:record',
    eventSource: 'aws:kinesis',
    eventVersion: '1.0',
    eventSourceARN: 'arn:aws:kinesis:us-east-1:123456789012:stream/s',
    awsRegion: 'us-east-1',
    invokeIdentityArn: 'arn:aws:iam::123456789012:role/r',
  };
}

function event(records: ReturnType<typeof kinesisRecord>[]): KinesisStreamEvent {
  return { Records: records } as unknown as KinesisStreamEvent;
}

const ev = (runId: string, status: string) => ({
  'detail-type': 'Task Status Change',
  source: 'aws.omics',
  time: '2026-09-30T12:00:00Z',
  detail: { runId, status, arn: `arn:aws:omics:us-east-1:123456789012:task/${runId}` },
});

describe('kinesisHandler', () => {
  beforeEach(() => {
    pipeline.mockReset();
    pipeline.mockResolvedValue(undefined);
  });

  it('decodes each record and runs it through the shared pipeline', async () => {
    const res = await handler(
      event([
        kinesisRecord('49590001', ev('run-1', 'RUNNING')),
        kinesisRecord('49590002', ev('run-1', 'COMPLETED')),
      ]),
    );
    expect(pipeline).toHaveBeenCalledTimes(2);
    // The pipeline receives the decoded EventBridge event.
    expect((pipeline.mock.calls[0][0] as { detail: { status: string } }).detail.status).toBe(
      'RUNNING',
    );
    expect(res.batchItemFailures).toEqual([]);
  });

  it('reports the failing record sequence number so Lambda retries from there', async () => {
    // First record succeeds, second throws, third would follow.
    pipeline
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('enrichment incomplete'))
      .mockResolvedValue(undefined);

    const res = await handler(
      event([
        kinesisRecord('49590001', ev('run-1', 'RUNNING')),
        kinesisRecord('49590002', ev('run-1', 'COMPLETED')),
        kinesisRecord('49590003', ev('run-2', 'RUNNING')),
      ]),
    );

    // Retry-from-earliest-failure: report the second record's sequence number
    // and stop; Lambda replays from there (the DynamoDB guards make the
    // already-processed first record a harmless no-op on replay).
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: '49590002' }]);
    // Processing stopped at the failure (did not process record 3 in this pass).
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('reports the record as a failure when its body is malformed (poison -> DLQ)', async () => {
    const bad = kinesisRecord('49590009', {});
    // Corrupt the base64 payload so JSON.parse throws.
    bad.kinesis.data = Buffer.from('not json', 'utf8').toString('base64');
    const res = await handler(event([bad]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: '49590009' }]);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('returns no failures for an empty batch', async () => {
    const res = await handler(event([]));
    expect(res.batchItemFailures).toEqual([]);
    expect(pipeline).not.toHaveBeenCalled();
  });
});
