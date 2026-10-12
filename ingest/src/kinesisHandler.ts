/**
 * Kinesis batch-consumer entry point — the toggle-able alternative ingest path.
 *
 * Architecture: an EventBridge rule
 * targets a Kinesis Data Stream instead of invoking the ingest Lambda directly,
 * with the record **PartitionKey set from `$.detail.runId`** (EventBridge →
 * Kinesis supports a NATIVE dynamic partition key — the reason we chose Kinesis
 * over SQS FIFO, whose MessageGroupId cannot be templated). Keying by runId puts
 * all of a run's events on one shard, giving in-order-per-run delivery while
 * parallelizing across runs (across shards). This Lambda is the stream's
 * consumer, invoked with a BATCH of records per shard.
 *
 * Each Kinesis record's `data` is base64-encoded; decoded it is the original
 * EventBridge event JSON. We process each through the EXACT SAME production
 * pipeline as the direct EventBridge handler (via {@link getDefaultHandler}),
 * so the two paths cannot drift. Ordering correctness still lives in the
 * DynamoDB monotonic + status guards (per-shard order reduces reordering but is
 * not relied upon for correctness — identical posture to the direct path).
 *
 * Partial-batch failure: we return
 * `{ batchItemFailures: [{ itemIdentifier: <sequenceNumber> }] }` (the Lambda
 * Kinesis `ReportBatchItemFailures` response). For a Kinesis event source this
 * tells Lambda to retry FROM the earliest reported sequence number, so a failed
 * record (e.g. a terminal task whose enrichment threw) is retried without
 * losing the ones after it. Combined with `bisectBatchOnFunctionError` +
 * a max-retry/max-age on the event-source mapping, a poison record is
 * eventually routed to the on-failure DLQ rather than blocking the shard.
 */
import type { EventBridgeEvent, KinesisStreamEvent, KinesisStreamBatchResponse } from 'aws-lambda';

import { getDefaultHandler } from './handler.js';

/**
 * Lambda entry point for the Kinesis event-source mapping.
 *
 * Processes each record through the shared ingest pipeline in shard order.
 * Records are processed sequentially so the earliest failure can be reported
 * as the checkpoint; on any record failure we report that record's sequence
 * number (and stop advancing the reported checkpoint) so Lambda retries from
 * there. Never throws — a thrown handler error is caught and converted into a
 * reported failure.
 */
export async function handler(
  event: KinesisStreamEvent,
): Promise<KinesisStreamBatchResponse> {
  const pipeline = getDefaultHandler();

  for (let i = 0; i < event.Records.length; i += 1) {
    const record = event.Records[i];
    try {
      // kinesis.data is base64-encoded; decoded it is the EventBridge event.
      const decoded = Buffer.from(record.kinesis.data, 'base64').toString('utf8');
      const ebEvent = JSON.parse(decoded) as EventBridgeEvent<string, unknown>;
      await pipeline(ebEvent);
    } catch (err) {
      // Report THIS record's sequence number as the failure checkpoint. Lambda
      // retries the batch from here (this record and everything after it), so
      // the already-processed earlier records are not reprocessed. The
      // DynamoDB monotonic/status guards make any incidental reprocessing a
      // harmless no-op anyway.
      console.error(
        `kinesisHandler: record ${record.kinesis.sequenceNumber} failed; ` +
          `reporting as batch item failure (retry from this sequence)`,
        err,
      );
      return {
        batchItemFailures: [{ itemIdentifier: record.kinesis.sequenceNumber }],
      };
    }
  }

  // All records processed successfully — no failures to report.
  return { batchItemFailures: [] };
}
