import { Stack, StackProps } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { IRole } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';
import { ApiStack } from './api-stack';
export interface IngestStackProps extends StackProps {
    /** The data layer the ingest Lambda writes to. */
    readonly dataStack: DataStack;
    /** The API the ingest Lambda publishes updates through. */
    readonly apiStack: ApiStack;
}
/**
 * IngestStack — the event-ingest layer.
 *
 * Owns the ingest Lambda (NodejsFunction / esbuild), the EventBridge rule on
 * the default bus (source = aws.omics), the SQS dead-letter queue and retry
 * policy, and (in task 10.2) least-privilege IAM.
 *
 * Event source (design.md "Infrastructure and IAM → EventBridge, DLQ, retry"):
 *   A rule on the DEFAULT event bus with pattern `{"source": ["aws.omics"]}`
 *   (Req 1.1) targets the ingest Lambda with a retry policy of at most 3
 *   attempts (Req 11.3), routing deliveries that still fail to the SQS DLQ
 *   (Req 1.7).
 *
 * The ingest Lambda is a NodejsFunction: esbuild bundles the ESM TypeScript
 * handler for the Node.js 20.x runtime. The AWS SDK v3 clients the handler uses
 * are provided by the Lambda runtime, so `@aws-sdk/*` is marked external rather
 * than bundled. Its render/publish targets are supplied as environment
 * variables (`TABLE_NAME`, `APPSYNC_ENDPOINT`); `AWS_REGION` is injected by the
 * Lambda runtime.
 *
 * The ingest function and its execution role are exposed as stack properties so
 * task 10.2 can attach the DynamoDB / AppSync / HealthOmics least-privilege
 * grants (Req 2.3, 4.4, 11.2) — deliberately NOT granted here.
 *
 * Requirements: 1.1, 1.2, 1.7, 11.3 (this task); 2.3, 4.4, 11.2 (task 10.2).
 */
export declare class IngestStack extends Stack {
    /** The ingest Lambda function; task 10.2 attaches least-privilege IAM to it. */
    readonly ingestFunction: NodejsFunction;
    /** The ingest Lambda execution role, exposed for least-privilege grants (task 10.2). */
    readonly ingestRole: IRole;
    /** The SQS dead-letter queue capturing deliveries that fail after retries (Req 1.7). */
    readonly deadLetterQueue: Queue;
    constructor(scope: Construct, id: string, props: IngestStackProps);
    /**
     * Provision the alternative Kinesis Data Streams ingest path (additive,
     * toggle-able).
     *
     * Creates: an on-demand Kinesis stream, a batch-consumer Lambda reusing the
     * ingest handler pipeline (via kinesisHandler.ts → getDefaultHandler), and the
     * Kinesis event-source mapping with ReportBatchItemFailures + bisect-on-error
     * + a bounded retry/age and an on-failure DLQ. When `mode === 'active'`, the
     * passed EventBridge rule targets the stream with a NATIVE dynamic
     * PartitionKey (`$.detail.runId`) so all of a run's events land on one shard
     * (in-order per run, parallel across runs). When merely 'present', the stream
     * is idle and the caller keeps the direct Lambda target.
     *
     * Consumer scaling: Kinesis consumer concurrency = shards × parallelization
     * factor. Ordering correctness remains at the DynamoDB monotonic + status
     * guards (per-shard order reduces reordering but is not relied upon). The
     * terminal-only enrichment governor (per-instance limiter) keeps GetRunTask
     * within the ~10 TPS HealthOmics bucket regardless of shard fan-out.
     */
    private buildKinesisIngestPath;
}
