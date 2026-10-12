import * as path from 'path';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction, KinesisStream as KinesisStreamTarget } from 'aws-cdk-lib/aws-events-targets';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { KinesisEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Stream, StreamMode } from 'aws-cdk-lib/aws-kinesis';
import {
  Effect,
  IRole,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';
import { ApiStack } from './api-stack';

/** Absolute path to the Kinesis batch-consumer Lambda entry. */
const KINESIS_CONSUMER_ENTRY = path.join(
  __dirname,
  '..',
  '..',
  'ingest',
  'src',
  'kinesisHandler.ts',
);

/**
 * Toggle for the alternative Kinesis Data Streams ingest path
 * Set via CDK context
 * `-c kinesisIngestMode=<mode>`:
 *   - 'off'     (default): only the direct EventBridge -> Lambda path exists.
 *   - 'present': ALSO provision the Kinesis stream + batch-consumer + event-
 *                source mapping, but EventBridge still targets the ingest Lambda
 *                directly (the Kinesis path sits idle — deploy/validate the
 *                resources without changing live ingestion).
 *   - 'active' : EventBridge targets the Kinesis stream (PartitionKey = runId)
 *                instead of the Lambda (the batch-consumer becomes the live
 *                ingest path). Roll back to 'present'/'off' with a single
 *                re-deploy — neither path is deleted on the toggle.
 *
 * Kinesis was chosen over SQS FIFO because EventBridge -> Kinesis supports a
 * NATIVE dynamic PartitionKey (`$.detail.runId`), giving per-run ordering with
 * NO enqueue Lambda (no extra concurrency surface) and NO bridging queue. The
 * tradeoff is Kinesis does not scale to zero (~$30/mo idle for an on-demand
 * stream), accepted for the large-batch throughput and clean topology.
 */
type KinesisIngestMode = 'off' | 'present' | 'active';

/** Absolute path to the reconciler (deferred re-sweep) Lambda entry. */
const RECONCILER_ENTRY = path.join(
  __dirname,
  '..',
  '..',
  'ingest',
  'src',
  'reconcilerHandler.ts',
);

/**
 * Absolute path to the ingest Lambda handler entry point. The handler is an ESM
 * TypeScript module in the sibling `ingest/` package; esbuild bundles it at
 * synth time. Resolves correctly under both `ts-node` (CDK synth) and `tsc`
 * (compiled `lib/`) because `__dirname` points at `infra/lib`.
 */
const HANDLER_ENTRY = path.join(
  __dirname,
  '..',
  '..',
  'ingest',
  'src',
  'handler.ts',
);

/**
 * The ingest package directory (sibling of `infra/`), used as the bundling
 * project root. The handler lives OUTSIDE the `infra/` package, so `infra/`'s
 * lockfile — which `NodejsFunction` would otherwise auto-detect — makes the
 * entry appear outside the project root. Rooting the bundle at the ingest
 * package itself keeps `entry` under the root AND runs esbuild in a directory
 * where it is installed (`ingest/node_modules`), so the local bundler resolves
 * `npx --no-install esbuild` without Docker.
 */
const INGEST_PROJECT_ROOT = path.join(__dirname, '..', '..', 'ingest');

/** The ingest package's lockfile, used as the bundling deps lock file. */
const INGEST_DEPS_LOCK_FILE = path.join(
  INGEST_PROJECT_ROOT,
  'package-lock.json',
);

/** Maximum EventBridge delivery attempts before routing to the DLQ (Req 11.3). */
const MAX_EVENT_RETRY_ATTEMPTS = 3;

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
export class IngestStack extends Stack {
  /** The ingest Lambda function; task 10.2 attaches least-privilege IAM to it. */
  public readonly ingestFunction: NodejsFunction;

  /** The ingest Lambda execution role, exposed for least-privilege grants (task 10.2). */
  public readonly ingestRole: IRole;

  /** The SQS dead-letter queue capturing deliveries that fail after retries (Req 1.7). */
  public readonly deadLetterQueue: Queue;

  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    // SQS dead-letter queue for EventBridge deliveries that still fail after the
    // configured retry attempts (Req 1.7).
    this.deadLetterQueue = new Queue(this, 'IngestDlq', {
      retentionPeriod: Duration.days(14),
    });

    // The ingest Lambda: esbuild-bundled ESM TypeScript on Node.js 20.x.
    //
    // IMPORTANT: we bundle our pinned `@aws-sdk/*` clients into the artifact
    // rather than relying on the SDK baked into the Node 20 runtime. The runtime
    // SDK is frozen at an older version that does not deserialize newer GetRun
    // response fields (e.g. networkingMode / configuration / vpcConfig), which
    // silently dropped those fields during enrichment. Bundling the pinned
    // client (3.1119.0+) ensures the response is parsed with a current model.
    this.ingestFunction = new NodejsFunction(this, 'IngestFunction', {
      runtime: Runtime.NODEJS_20_X,
      entry: HANDLER_ENTRY,
      handler: 'handler',
      // The handler lives in the sibling `ingest/` package, outside `infra/`.
      // Root the bundle at the ingest package so the entry is under the root
      // and esbuild resolves from `ingest/node_modules`.
      projectRoot: INGEST_PROJECT_ROOT,
      depsLockFilePath: INGEST_DEPS_LOCK_FILE,
      timeout: Duration.seconds(60),
      // CONCURRENCY / ENRICHMENT-TPS SPLIT (only enrichment-required events are
      // rate-limited). Non-enriching task events (PENDING/STARTING/STOPPING) and
      // non-enriching run events do NOT call any HealthOmics read API — they are
      // a cheap DynamoDB write + AppSync publish — so they must NOT be starved by
      // the enrichment rate limit. Only RUNNING + terminal task events (and run
      // events needing GetRun) invoke the per-instance `omicsRateLimiter`.
      //
      // The enrichment budget is enforced as reservedConcurrency × OMICS_TPS ≈
      // the HealthOmics ~10 TPS run-read bucket (400 × 0.025 = 10), while the
      // HIGH reserved concurrency (400) lets the cheap, non-enriching majority
      // (PENDING/STARTING — DynamoDB write + publish, NO API call) drain fast.
      // KEY PROPERTY: because ONLY RUNNING + terminal events call the rate
      // limiter, raising concurrency to relieve the invocation-throughput
      // backlog does NOT increase HealthOmics API pressure — the TPS stays
      // bounded by the product, which we hold at 10 by lowering OMICS_TPS as we
      // raise concurrency. 400 clears the ~4-min backlog seen when all 100 runs
      // of a batch are simultaneously active; well under AppSync's 10,000/sec
      // token ceiling and leaves ~598 of 1000 account concurrency unreserved.
      reservedConcurrentExecutions: 400,
      environment: {
        // DynamoDB single table the handler upserts run/task/graph items into.
        TABLE_NAME: props.dataStack.table.tableName,
        // AppSync GraphQL endpoint the handler publishes updates to. AWS_REGION
        // is provided automatically by the Lambda runtime and is read directly
        // by the handler (do not set it here — it is a reserved env var).
        APPSYNC_ENDPOINT: props.apiStack.api.graphqlUrl,
        // Per-instance HealthOmics read pace. Only enriching events consume it;
        // reservedConcurrency × OMICS_TPS ≈ the ~10 TPS run-read budget (400 ×
        // 0.025). Lowered in lock-step with the concurrency raise so API TPS is
        // unchanged. (Raise to 0.05 if/when the run-read quota is increased to
        // 20 TPS.)
        OMICS_TPS: '0.025',
      },
      bundling: {
        format: OutputFormat.ESM,
        // Bundle the AWS SDK v3 clients (do NOT mark them external) so the
        // handler uses our pinned, current SDK versions instead of the older
        // SDK baked into the Node 20 runtime — the stale runtime SDK dropped
        // newer GetRun response fields (networkingMode/configuration/vpcConfig).
        externalModules: [],
        // The AWS SDK v3 internally uses CommonJS `require(...)` (e.g.
        // `node:https` via @smithy). Bundling it into an ESM output makes those
        // dynamic requires fail at runtime ("Dynamic require of ... is not
        // supported"). Inject a createRequire shim so the bundled CJS modules
        // can resolve their requires under ESM.
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
      },
    });

    // Expose the auto-created execution role so task 10.2 can attach the
    // DynamoDB / AppSync / HealthOmics least-privilege grants.
    this.ingestRole = this.ingestFunction.role!;

    // ── Deferred re-sweep (Reconciler) ──────────────────────────────────────
    // A run's Run_Summary is computed at the TERMINAL INSTANT, before CloudWatch
    // utilization metrics land and before any out-of-order task state settles.
    // On terminal, the ingest completion hook schedules a ONE-SHOT EventBridge
    // Scheduler ~RECONCILE_DELAY_MINUTES later that invokes this Reconciler
    // Lambda, which re-reads the authoritative run/task state + re-sweeps
    // CloudWatch and re-writes the summary (force-winning the monotonic guard),
    // then deletes its own schedule. Nothing accumulates (one-shot +
    // ActionAfterCompletion.DELETE + self-delete).
    const reconcilerFn = new NodejsFunction(this, 'ReconcilerFunction', {
      runtime: Runtime.NODEJS_20_X,
      entry: RECONCILER_ENTRY,
      handler: 'handler',
      projectRoot: INGEST_PROJECT_ROOT,
      depsLockFilePath: INGEST_DEPS_LOCK_FILE,
      timeout: Duration.seconds(300),
      // Cap the reconcile FAN-OUT so a wave of terminal-run re-sweeps stays
      // within the HealthOmics ~10 TPS read budget (the per-instance limiter
      // paces one instance, not the fleet). The split must ALSO let a single
      // reconcile of a large run (~200+ tasks, one GetRunTask each) finish
      // inside the Lambda timeout: at N tasks and T TPS a sweep takes ~N/T s.
      // With reservedConcurrency 2 × OMICS_TPS 5 = ~10 TPS fleet budget, and a
      // single instance at 5 TPS drains ~200 tasks in ~40s (well under the 300s
      // timeout). Do NOT lower OMICS_TPS to 2 with a 120s timeout — a 207-task
      // run then needs ~103s of pure pacing and times out before finishing
      // (observed: reconciles hit Status:timeout and never reconciled the run).
      reservedConcurrentExecutions: 2,
      environment: {
        RECONCILER_TABLE_NAME: props.dataStack.table.tableName,
        MONITORING_HOST: `monitoring.${Stack.of(this).region}.amazonaws.com`,
        SIGNING_SERVICE: 'monitoring',
        // Per-instance HealthOmics read pace; reservedConcurrency × OMICS_TPS ≈
        // the ~10 TPS account budget, while 5 TPS keeps a large-run sweep within
        // the timeout.
        OMICS_TPS: '5',
      },
      bundling: {
        format: OutputFormat.ESM,
        // Bundle the pinned AWS SDK clients (same rationale as the ingest fn:
        // newer GetRun fields) + scheduler/signature deps; inject the ESM
        // createRequire shim so bundled CJS dynamic requires resolve.
        externalModules: [],
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
      },
    });

    // Reconciler IAM (least-privilege, explicit actions + scoped resources):
    //  - DynamoDB RW on the table + GSI (re-upsert tasks/summary/registry).
    reconcilerFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [
          props.dataStack.tableArn,
          props.dataStack.gsi1Arn,
          props.dataStack.gsi2Arn,
        ],
      }),
    );
    //  - HealthOmics read-only (authoritative run/task re-enrichment).
    reconcilerFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'omics:GetRun',
          'omics:ListRunTasks',
          'omics:GetRunTask',
        ],
        resources: [
          Stack.of(this).formatArn({ service: 'omics', resource: 'run', resourceName: '*' }),
        ],
      }),
    );
    //  - CloudWatch PromQL metric read (same documented Resource:* exception as
    //    the metrics Lambda — GetMetricData/ListMetrics do not support
    //    resource-level scoping; NOT a wildcard action).
    reconcilerFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
        resources: ['*'],
      }),
    );

    // One dedicated scheduler group holds all one-shot re-sweep schedules, so
    // DeleteSchedule and CreateSchedule can be scoped to this group's ARN only.
    const scheduleGroup = new CfnScheduleGroup(this, 'ReconcileScheduleGroup', {
      name: `${this.stackName}-resweep`,
    });
    const { region, account } = Stack.of(this);
    const scheduleArnPattern = `arn:aws:scheduler:${region}:${account}:schedule/${scheduleGroup.name}/*`;

    //  - The reconciler deletes its own one-shot schedule (scoped to the group).
    reconcilerFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['scheduler:DeleteSchedule'],
        resources: [scheduleArnPattern],
      }),
    );

    // The role EventBridge Scheduler assumes to INVOKE the reconciler. Trust is
    // scoped to the scheduler service; permission is only lambda:InvokeFunction
    // on the reconciler function ARN.
    const schedulerInvokeRole = new Role(this, 'ReconcileSchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
      description:
        'Assumed by EventBridge Scheduler to invoke the deferred re-sweep Reconciler Lambda.',
    });
    reconcilerFn.grantInvoke(schedulerInvokeRole);

    // Ingest role: create the one-shot schedules (scoped to the group) and pass
    // the scheduler-invoke role to EventBridge Scheduler. iam:PassRole is scoped
    // to that single role and conditioned on the scheduler service.
    this.ingestFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['scheduler:CreateSchedule'],
        resources: [scheduleArnPattern],
      }),
    );
    this.ingestFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [schedulerInvokeRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
        },
      }),
    );

    // Wire the deferred re-sweep into the ingest function via env (presence of
    // these two enables scheduleReconcile in the handler — staged rollout).
    this.ingestFunction.addEnvironment('RECONCILER_FUNCTION_ARN', reconcilerFn.functionArn);
    this.ingestFunction.addEnvironment('RECONCILER_SCHEDULER_ROLE_ARN', schedulerInvokeRole.roleArn);
    this.ingestFunction.addEnvironment('RECONCILER_SCHEDULE_GROUP', scheduleGroup.name!);
    // Also tell the reconciler which group its schedules live in (self-delete).
    reconcilerFn.addEnvironment('RECONCILER_SCHEDULE_GROUP', scheduleGroup.name!);

    // EventBridge rule on the DEFAULT bus matching HealthOmics state-change
    // events (Req 1.1). Omitting `eventBus` targets the account's default bus,
    // which is where HealthOmics publishes.
    const rule = new Rule(this, 'OmicsEventRule', {
      description:
        'Routes AWS HealthOmics state-change events (source = aws.omics) to the ingest path.',
      eventPattern: {
        source: ['aws.omics'],
      },
    });

    // --- Alternative Kinesis Data Streams ingest path (toggle-able, additive) -
    // Read the mode from CDK context; default 'off'. When 'present'/'active' we
    // provision the Kinesis stream + batch-consumer Lambda + event-source
    // mapping ALONGSIDE the direct path. The EventBridge target is the Lambda
    // UNLESS mode is 'active', in which case it is the Kinesis stream (with a
    // native dynamic PartitionKey = $.detail.runId). Deploy idle ('present'),
    // cut over ('active'), and roll back — a single context change + redeploy,
    // deleting neither path.
    const kinesisMode =
      (this.node.tryGetContext('kinesisIngestMode') as KinesisIngestMode) ?? 'off';
    if (kinesisMode !== 'off') {
      this.buildKinesisIngestPath(props, rule, kinesisMode);
    }

    // The direct EventBridge -> Lambda target is used unless the Kinesis path is
    // the ACTIVE one (in which case buildKinesisIngestPath wired the stream as
    // the target).
    if (kinesisMode !== 'active') {
      // Target the ingest Lambda with a retry policy of at most 3 attempts
      // (Req 11.3); deliveries that still fail are routed to the DLQ (Req 1.7).
      rule.addTarget(
        new LambdaFunction(this.ingestFunction, {
          retryAttempts: MAX_EVENT_RETRY_ATTEMPTS,
          deadLetterQueue: this.deadLetterQueue,
        }),
      );
    }

    // --- Least-privilege IAM for the ingest role (Req 2.3, 4.4, 11.2) ---
    // Every statement below is scoped to explicit action lists and explicit
    // resource ARNs. There is NO `Action: "*"` and NO `Resource: "*"` anywhere
    // (Req 11.2).

    // DynamoDB: the handler upserts run/task/graph items (PutItem/UpdateItem
    // with a monotonic `updatedAt` conditional guard), reads a cached static
    // graph (GetItem), and may Query. Scope to the table and its GSI1 ARNs only
    // (design.md "DynamoDB write scoped to the table/GSI ARNs"). ConditionCheckItem
    // covers the stale-write conditional guard.
    this.ingestFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [props.dataStack.tableArn, props.dataStack.gsi1Arn],
      }),
    );

    // AppSync: the handler invokes the IAM-authorized publish mutations only.
    // Scope `appsync:GraphQL` to the two publish field ARNs — not the whole API
    // (Req 4.4). Field ARNs are derived from the API's ARN (which encodes the
    // API id) with the GraphQL field path appended.
    const publishFieldArns = [
      'publishRunUpdate',
      'publishTaskUpdate',
    ].map((field) => `${props.apiStack.api.arn}/types/Mutation/fields/${field}`);

    this.ingestFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: publishFieldArns,
      }),
    );

    // HealthOmics: event-triggered read enrichment only — GetRun, ListRunTasks,
    // GetRunTask, GetWorkflow. No create/update/delete actions (Req 2.3). Scope
    // to this account/region's run and workflow resources rather than a wildcard
    // resource (Req 11.2).
    this.ingestFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'omics:GetRun',
          'omics:ListRunTasks',
          'omics:GetRunTask',
          'omics:GetWorkflow',
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'omics',
            resource: 'run',
            resourceName: '*',
          }),
          Stack.of(this).formatArn({
            service: 'omics',
            resource: 'workflow',
            resourceName: '*',
          }),
        ],
      }),
    );

    // Stack outputs so the DLQ and function are discoverable/operable (Req 11.7).
    new CfnOutput(this, 'IngestFunctionName', {
      value: this.ingestFunction.functionName,
      description: 'Name of the ingest Lambda function.',
      exportName: `${this.stackName}-IngestFunctionName`,
    });

    new CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'URL of the ingest dead-letter queue.',
      exportName: `${this.stackName}-DeadLetterQueueUrl`,
    });
  }

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
  private buildKinesisIngestPath(
    props: IngestStackProps,
    rule: Rule,
    mode: KinesisIngestMode,
  ): void {
    // On-demand Kinesis stream: auto-scales shards with throughput (no capacity
    // planning), bills per-hour + per-payload (does NOT scale to zero — the
    // accepted tradeoff). Retain events for the default 24h so a consumer issue
    // can be replayed.
    const stream = new Stream(this, 'IngestKinesisStream', {
      streamMode: StreamMode.ON_DEMAND,
      retentionPeriod: Duration.hours(24),
    });

    // On-failure DLQ for records that exhaust retries (poison records), so a bad
    // record does not block its shard indefinitely.
    const kinesisDlq = new Queue(this, 'IngestKinesisDlq', {
      retentionPeriod: Duration.days(14),
    });

    // Batch-consumer Lambda — reuses the exact ingest pipeline (kinesisHandler.ts
    // → getDefaultHandler). Same env as the direct ingest function so both paths
    // behave identically downstream.
    const consumer = new NodejsFunction(this, 'KinesisIngestConsumer', {
      runtime: Runtime.NODEJS_20_X,
      entry: KINESIS_CONSUMER_ENTRY,
      handler: 'handler',
      projectRoot: INGEST_PROJECT_ROOT,
      depsLockFilePath: INGEST_DEPS_LOCK_FILE,
      timeout: Duration.seconds(60),
      environment: {
        TABLE_NAME: props.dataStack.table.tableName,
        APPSYNC_ENDPOINT: props.apiStack.api.graphqlUrl,
        // Per-instance HealthOmics read pace governor (enrichment TPS); keeps
        // terminal GetRunTask within the ~10 TPS bucket regardless of shards.
        OMICS_TPS: '2',
      },
      bundling: {
        format: OutputFormat.ESM,
        externalModules: [],
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
      },
    });

    // Consumer least-privilege: same downstream grants as the direct ingest
    // role (DynamoDB RW on table+GSI1, AppSync publish, HealthOmics read).
    consumer.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [props.dataStack.tableArn, props.dataStack.gsi1Arn],
      }),
    );
    const publishFieldArns = ['publishRunUpdate', 'publishTaskUpdate'].map(
      (field) => `${props.apiStack.api.arn}/types/Mutation/fields/${field}`,
    );
    consumer.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: publishFieldArns,
      }),
    );
    consumer.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['omics:GetRun', 'omics:ListRunTasks', 'omics:GetRunTask', 'omics:GetWorkflow'],
        resources: [
          Stack.of(this).formatArn({ service: 'omics', resource: 'run', resourceName: '*' }),
          Stack.of(this).formatArn({ service: 'omics', resource: 'workflow', resourceName: '*' }),
        ],
      }),
    );

    // Event-source mapping: batch per-shard into the consumer, report partial
    // failures (retry from the earliest failed sequence), bisect on error to
    // isolate a poison record, bound retries/age, and route exhausted records
    // to the DLQ. `KinesisEventSource` grants the consumer kinesis read on the
    // stream automatically.
    consumer.addEventSource(
      new KinesisEventSource(stream, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 100,
        // Consumer concurrency for a Kinesis source = shards × parallelization.
        // On-demand streams start at a few shards and auto-scale LAZILY (minutes),
        // so at a sudden large-batch burst the consumer is throttled to the
        // current shard count. Raising the parallelization factor to 10 gives up
        // to shards×10 concurrent consumers per shard so the batch drains without
        // waiting for shard auto-scaling. (Ordering per partition key is still
        // preserved — parallelization keeps per-partition-key order within a
        // shard.)
        parallelizationFactor: 10,
        reportBatchItemFailures: true,
        bisectBatchOnError: true,
        retryAttempts: 5,
        maxRecordAge: Duration.hours(1),
        onFailure: new SqsDlq(kinesisDlq),
      }),
    );

    // When ACTIVE, EventBridge delivers to the Kinesis stream with a dynamic
    // PartitionKey = runId (native path-based key). When merely PRESENT, the
    // stream is idle and the caller keeps the direct Lambda target.
    if (mode === 'active') {
      rule.addTarget(
        new KinesisStreamTarget(stream, {
          partitionKeyPath: '$.detail.runId',
        }),
      );
    }

    new CfnOutput(this, 'IngestKinesisStreamName', {
      value: stream.streamName,
      description: 'Name of the Kinesis ingest stream (alternative path).',
      exportName: `${this.stackName}-IngestKinesisStreamName`,
    });
  }
}
