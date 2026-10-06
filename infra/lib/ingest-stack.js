"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestStack = void 0;
const path = __importStar(require("path"));
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_events_1 = require("aws-cdk-lib/aws-events");
const aws_events_targets_1 = require("aws-cdk-lib/aws-events-targets");
const aws_lambda_1 = require("aws-cdk-lib/aws-lambda");
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const aws_lambda_event_sources_1 = require("aws-cdk-lib/aws-lambda-event-sources");
const aws_kinesis_1 = require("aws-cdk-lib/aws-kinesis");
const aws_iam_1 = require("aws-cdk-lib/aws-iam");
const aws_sqs_1 = require("aws-cdk-lib/aws-sqs");
const aws_scheduler_1 = require("aws-cdk-lib/aws-scheduler");
/** Absolute path to the Kinesis batch-consumer Lambda entry. */
const KINESIS_CONSUMER_ENTRY = path.join(__dirname, '..', '..', 'ingest', 'src', 'kinesisHandler.ts');
/** Absolute path to the reconciler (deferred re-sweep) Lambda entry. */
const RECONCILER_ENTRY = path.join(__dirname, '..', '..', 'ingest', 'src', 'reconcilerHandler.ts');
/**
 * Absolute path to the ingest Lambda handler entry point. The handler is an ESM
 * TypeScript module in the sibling `ingest/` package; esbuild bundles it at
 * synth time. Resolves correctly under both `ts-node` (CDK synth) and `tsc`
 * (compiled `lib/`) because `__dirname` points at `infra/lib`.
 */
const HANDLER_ENTRY = path.join(__dirname, '..', '..', 'ingest', 'src', 'handler.ts');
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
const INGEST_DEPS_LOCK_FILE = path.join(INGEST_PROJECT_ROOT, 'package-lock.json');
/** Maximum EventBridge delivery attempts before routing to the DLQ (Req 11.3). */
const MAX_EVENT_RETRY_ATTEMPTS = 3;
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
class IngestStack extends aws_cdk_lib_1.Stack {
    /** The ingest Lambda function; task 10.2 attaches least-privilege IAM to it. */
    ingestFunction;
    /** The ingest Lambda execution role, exposed for least-privilege grants (task 10.2). */
    ingestRole;
    /** The SQS dead-letter queue capturing deliveries that fail after retries (Req 1.7). */
    deadLetterQueue;
    constructor(scope, id, props) {
        super(scope, id, props);
        // SQS dead-letter queue for EventBridge deliveries that still fail after the
        // configured retry attempts (Req 1.7).
        this.deadLetterQueue = new aws_sqs_1.Queue(this, 'IngestDlq', {
            retentionPeriod: aws_cdk_lib_1.Duration.days(14),
        });
        // The ingest Lambda: esbuild-bundled ESM TypeScript on Node.js 20.x.
        //
        // IMPORTANT: we bundle our pinned `@aws-sdk/*` clients into the artifact
        // rather than relying on the SDK baked into the Node 20 runtime. The runtime
        // SDK is frozen at an older version that does not deserialize newer GetRun
        // response fields (e.g. networkingMode / configuration / vpcConfig), which
        // silently dropped those fields during enrichment. Bundling the pinned
        // client (3.1119.0+) ensures the response is parsed with a current model.
        this.ingestFunction = new aws_lambda_nodejs_1.NodejsFunction(this, 'IngestFunction', {
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            entry: HANDLER_ENTRY,
            handler: 'handler',
            // The handler lives in the sibling `ingest/` package, outside `infra/`.
            // Root the bundle at the ingest package so the entry is under the root
            // and esbuild resolves from `ingest/node_modules`.
            projectRoot: INGEST_PROJECT_ROOT,
            depsLockFilePath: INGEST_DEPS_LOCK_FILE,
            timeout: aws_cdk_lib_1.Duration.seconds(60),
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
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
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
                banner: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
            },
        });
        // Expose the auto-created execution role so task 10.2 can attach the
        // DynamoDB / AppSync / HealthOmics least-privilege grants.
        this.ingestRole = this.ingestFunction.role;
        // ── Deferred re-sweep (Reconciler) ──────────────────────────────────────
        // A run's Run_Summary is computed at the TERMINAL INSTANT, before CloudWatch
        // utilization metrics land and before any out-of-order task state settles.
        // On terminal, the ingest completion hook schedules a ONE-SHOT EventBridge
        // Scheduler ~RECONCILE_DELAY_MINUTES later that invokes this Reconciler
        // Lambda, which re-reads the authoritative run/task state + re-sweeps
        // CloudWatch and re-writes the summary (force-winning the monotonic guard),
        // then deletes its own schedule. Nothing accumulates (one-shot +
        // ActionAfterCompletion.DELETE + self-delete).
        const reconcilerFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'ReconcilerFunction', {
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            entry: RECONCILER_ENTRY,
            handler: 'handler',
            projectRoot: INGEST_PROJECT_ROOT,
            depsLockFilePath: INGEST_DEPS_LOCK_FILE,
            timeout: aws_cdk_lib_1.Duration.seconds(300),
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
                MONITORING_HOST: `monitoring.${aws_cdk_lib_1.Stack.of(this).region}.amazonaws.com`,
                SIGNING_SERVICE: 'monitoring',
                // Per-instance HealthOmics read pace; reservedConcurrency × OMICS_TPS ≈
                // the ~10 TPS account budget, while 5 TPS keeps a large-run sweep within
                // the timeout.
                OMICS_TPS: '5',
            },
            bundling: {
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
                // Bundle the pinned AWS SDK clients (same rationale as the ingest fn:
                // newer GetRun fields) + scheduler/signature deps; inject the ESM
                // createRequire shim so bundled CJS dynamic requires resolve.
                externalModules: [],
                banner: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
            },
        });
        // Reconciler IAM (least-privilege, explicit actions + scoped resources):
        //  - DynamoDB RW on the table + GSI (re-upsert tasks/summary/registry).
        reconcilerFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
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
        }));
        //  - HealthOmics read-only (authoritative run/task re-enrichment).
        reconcilerFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: [
                'omics:GetRun',
                'omics:ListRunTasks',
                'omics:GetRunTask',
            ],
            resources: [
                aws_cdk_lib_1.Stack.of(this).formatArn({ service: 'omics', resource: 'run', resourceName: '*' }),
            ],
        }));
        //  - CloudWatch PromQL metric read (same documented Resource:* exception as
        //    the metrics Lambda — GetMetricData/ListMetrics do not support
        //    resource-level scoping; NOT a wildcard action).
        reconcilerFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
            resources: ['*'],
        }));
        // One dedicated scheduler group holds all one-shot re-sweep schedules, so
        // DeleteSchedule and CreateSchedule can be scoped to this group's ARN only.
        const scheduleGroup = new aws_scheduler_1.CfnScheduleGroup(this, 'ReconcileScheduleGroup', {
            name: `${this.stackName}-resweep`,
        });
        const { region, account } = aws_cdk_lib_1.Stack.of(this);
        const scheduleArnPattern = `arn:aws:scheduler:${region}:${account}:schedule/${scheduleGroup.name}/*`;
        //  - The reconciler deletes its own one-shot schedule (scoped to the group).
        reconcilerFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['scheduler:DeleteSchedule'],
            resources: [scheduleArnPattern],
        }));
        // The role EventBridge Scheduler assumes to INVOKE the reconciler. Trust is
        // scoped to the scheduler service; permission is only lambda:InvokeFunction
        // on the reconciler function ARN.
        const schedulerInvokeRole = new aws_iam_1.Role(this, 'ReconcileSchedulerRole', {
            assumedBy: new aws_iam_1.ServicePrincipal('scheduler.amazonaws.com'),
            description: 'Assumed by EventBridge Scheduler to invoke the deferred re-sweep Reconciler Lambda.',
        });
        reconcilerFn.grantInvoke(schedulerInvokeRole);
        // Ingest role: create the one-shot schedules (scoped to the group) and pass
        // the scheduler-invoke role to EventBridge Scheduler. iam:PassRole is scoped
        // to that single role and conditioned on the scheduler service.
        this.ingestFunction.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['scheduler:CreateSchedule'],
            resources: [scheduleArnPattern],
        }));
        this.ingestFunction.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['iam:PassRole'],
            resources: [schedulerInvokeRole.roleArn],
            conditions: {
                StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
            },
        }));
        // Wire the deferred re-sweep into the ingest function via env (presence of
        // these two enables scheduleReconcile in the handler — staged rollout).
        this.ingestFunction.addEnvironment('RECONCILER_FUNCTION_ARN', reconcilerFn.functionArn);
        this.ingestFunction.addEnvironment('RECONCILER_SCHEDULER_ROLE_ARN', schedulerInvokeRole.roleArn);
        this.ingestFunction.addEnvironment('RECONCILER_SCHEDULE_GROUP', scheduleGroup.name);
        // Also tell the reconciler which group its schedules live in (self-delete).
        reconcilerFn.addEnvironment('RECONCILER_SCHEDULE_GROUP', scheduleGroup.name);
        // EventBridge rule on the DEFAULT bus matching HealthOmics state-change
        // events (Req 1.1). Omitting `eventBus` targets the account's default bus,
        // which is where HealthOmics publishes.
        const rule = new aws_events_1.Rule(this, 'OmicsEventRule', {
            description: 'Routes AWS HealthOmics state-change events (source = aws.omics) to the ingest path.',
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
        const kinesisMode = this.node.tryGetContext('kinesisIngestMode') ?? 'off';
        if (kinesisMode !== 'off') {
            this.buildKinesisIngestPath(props, rule, kinesisMode);
        }
        // The direct EventBridge -> Lambda target is used unless the Kinesis path is
        // the ACTIVE one (in which case buildKinesisIngestPath wired the stream as
        // the target).
        if (kinesisMode !== 'active') {
            // Target the ingest Lambda with a retry policy of at most 3 attempts
            // (Req 11.3); deliveries that still fail are routed to the DLQ (Req 1.7).
            rule.addTarget(new aws_events_targets_1.LambdaFunction(this.ingestFunction, {
                retryAttempts: MAX_EVENT_RETRY_ATTEMPTS,
                deadLetterQueue: this.deadLetterQueue,
            }));
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
        this.ingestFunction.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: [
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:ConditionCheckItem',
            ],
            resources: [props.dataStack.tableArn, props.dataStack.gsi1Arn],
        }));
        // AppSync: the handler invokes the IAM-authorized publish mutations only.
        // Scope `appsync:GraphQL` to the two publish field ARNs — not the whole API
        // (Req 4.4). Field ARNs are derived from the API's ARN (which encodes the
        // API id) with the GraphQL field path appended.
        const publishFieldArns = [
            'publishRunUpdate',
            'publishTaskUpdate',
        ].map((field) => `${props.apiStack.api.arn}/types/Mutation/fields/${field}`);
        this.ingestFunction.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['appsync:GraphQL'],
            resources: publishFieldArns,
        }));
        // HealthOmics: event-triggered read enrichment only — GetRun, ListRunTasks,
        // GetRunTask, GetWorkflow. No create/update/delete actions (Req 2.3). Scope
        // to this account/region's run and workflow resources rather than a wildcard
        // resource (Req 11.2).
        this.ingestFunction.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: [
                'omics:GetRun',
                'omics:ListRunTasks',
                'omics:GetRunTask',
                'omics:GetWorkflow',
            ],
            resources: [
                aws_cdk_lib_1.Stack.of(this).formatArn({
                    service: 'omics',
                    resource: 'run',
                    resourceName: '*',
                }),
                aws_cdk_lib_1.Stack.of(this).formatArn({
                    service: 'omics',
                    resource: 'workflow',
                    resourceName: '*',
                }),
            ],
        }));
        // Stack outputs so the DLQ and function are discoverable/operable (Req 11.7).
        new aws_cdk_lib_1.CfnOutput(this, 'IngestFunctionName', {
            value: this.ingestFunction.functionName,
            description: 'Name of the ingest Lambda function.',
            exportName: `${this.stackName}-IngestFunctionName`,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'DeadLetterQueueUrl', {
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
    buildKinesisIngestPath(props, rule, mode) {
        // On-demand Kinesis stream: auto-scales shards with throughput (no capacity
        // planning), bills per-hour + per-payload (does NOT scale to zero — the
        // accepted tradeoff). Retain events for the default 24h so a consumer issue
        // can be replayed.
        const stream = new aws_kinesis_1.Stream(this, 'IngestKinesisStream', {
            streamMode: aws_kinesis_1.StreamMode.ON_DEMAND,
            retentionPeriod: aws_cdk_lib_1.Duration.hours(24),
        });
        // On-failure DLQ for records that exhaust retries (poison records), so a bad
        // record does not block its shard indefinitely.
        const kinesisDlq = new aws_sqs_1.Queue(this, 'IngestKinesisDlq', {
            retentionPeriod: aws_cdk_lib_1.Duration.days(14),
        });
        // Batch-consumer Lambda — reuses the exact ingest pipeline (kinesisHandler.ts
        // → getDefaultHandler). Same env as the direct ingest function so both paths
        // behave identically downstream.
        const consumer = new aws_lambda_nodejs_1.NodejsFunction(this, 'KinesisIngestConsumer', {
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            entry: KINESIS_CONSUMER_ENTRY,
            handler: 'handler',
            projectRoot: INGEST_PROJECT_ROOT,
            depsLockFilePath: INGEST_DEPS_LOCK_FILE,
            timeout: aws_cdk_lib_1.Duration.seconds(60),
            environment: {
                TABLE_NAME: props.dataStack.table.tableName,
                APPSYNC_ENDPOINT: props.apiStack.api.graphqlUrl,
                // Per-instance HealthOmics read pace governor (enrichment TPS); keeps
                // terminal GetRunTask within the ~10 TPS bucket regardless of shards.
                OMICS_TPS: '2',
            },
            bundling: {
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
                externalModules: [],
                banner: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
            },
        });
        // Consumer least-privilege: same downstream grants as the direct ingest
        // role (DynamoDB RW on table+GSI1, AppSync publish, HealthOmics read).
        consumer.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: [
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:ConditionCheckItem',
            ],
            resources: [props.dataStack.tableArn, props.dataStack.gsi1Arn],
        }));
        const publishFieldArns = ['publishRunUpdate', 'publishTaskUpdate'].map((field) => `${props.apiStack.api.arn}/types/Mutation/fields/${field}`);
        consumer.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['appsync:GraphQL'],
            resources: publishFieldArns,
        }));
        consumer.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['omics:GetRun', 'omics:ListRunTasks', 'omics:GetRunTask', 'omics:GetWorkflow'],
            resources: [
                aws_cdk_lib_1.Stack.of(this).formatArn({ service: 'omics', resource: 'run', resourceName: '*' }),
                aws_cdk_lib_1.Stack.of(this).formatArn({ service: 'omics', resource: 'workflow', resourceName: '*' }),
            ],
        }));
        // Event-source mapping: batch per-shard into the consumer, report partial
        // failures (retry from the earliest failed sequence), bisect on error to
        // isolate a poison record, bound retries/age, and route exhausted records
        // to the DLQ. `KinesisEventSource` grants the consumer kinesis read on the
        // stream automatically.
        consumer.addEventSource(new aws_lambda_event_sources_1.KinesisEventSource(stream, {
            startingPosition: aws_lambda_1.StartingPosition.LATEST,
            batchSize: 100,
            reportBatchItemFailures: true,
            bisectBatchOnError: true,
            retryAttempts: 5,
            maxRecordAge: aws_cdk_lib_1.Duration.hours(1),
            onFailure: new aws_lambda_event_sources_1.SqsDlq(kinesisDlq),
        }));
        // When ACTIVE, EventBridge delivers to the Kinesis stream with a dynamic
        // PartitionKey = runId (native path-based key). When merely PRESENT, the
        // stream is idle and the caller keeps the direct Lambda target.
        if (mode === 'active') {
            rule.addTarget(new aws_events_targets_1.KinesisStream(stream, {
                partitionKeyPath: '$.detail.runId',
            }));
        }
        new aws_cdk_lib_1.CfnOutput(this, 'IngestKinesisStreamName', {
            value: stream.streamName,
            description: 'Name of the Kinesis ingest stream (alternative path).',
            exportName: `${this.stackName}-IngestKinesisStreamName`,
        });
    }
}
exports.IngestStack = IngestStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5nZXN0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiaW5nZXN0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDJDQUE2QjtBQUM3Qiw2Q0FBcUU7QUFDckUsdURBQThDO0FBQzlDLHVFQUFzRztBQUN0Ryx1REFBbUU7QUFDbkUscUVBQTZFO0FBQzdFLG1GQUFrRjtBQUNsRix5REFBNkQ7QUFDN0QsaURBTTZCO0FBQzdCLGlEQUE0QztBQUM1Qyw2REFBNkQ7QUFLN0QsZ0VBQWdFO0FBQ2hFLE1BQU0sc0JBQXNCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FDdEMsU0FBUyxFQUNULElBQUksRUFDSixJQUFJLEVBQ0osUUFBUSxFQUNSLEtBQUssRUFDTCxtQkFBbUIsQ0FDcEIsQ0FBQztBQXdCRix3RUFBd0U7QUFDeEUsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUNoQyxTQUFTLEVBQ1QsSUFBSSxFQUNKLElBQUksRUFDSixRQUFRLEVBQ1IsS0FBSyxFQUNMLHNCQUFzQixDQUN2QixDQUFDO0FBRUY7Ozs7O0dBS0c7QUFDSCxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUM3QixTQUFTLEVBQ1QsSUFBSSxFQUNKLElBQUksRUFDSixRQUFRLEVBQ1IsS0FBSyxFQUNMLFlBQVksQ0FDYixDQUFDO0FBRUY7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFNLG1CQUFtQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFFdkUsMEVBQTBFO0FBQzFFLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FDckMsbUJBQW1CLEVBQ25CLG1CQUFtQixDQUNwQixDQUFDO0FBRUYsa0ZBQWtGO0FBQ2xGLE1BQU0sd0JBQXdCLEdBQUcsQ0FBQyxDQUFDO0FBU25DOzs7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bnRlbnQiOlsiaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24sIFN0YWNrLCBTdGFja1Byb3BzIH0gZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgUnVsZSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMnO1xuaW1wb3J0IHsgTGFtYmRhRnVuY3Rpb24sIEtpbmVzaXNTdHJlYW0gYXMgS2luZXNpc1N0cmVhbVRhcmdldCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMtdGFyZ2V0cyc7XG5pbXBvcnQgeyBSdW50aW1lLCBTdGFydGluZ1Bvc2l0aW9uIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyBOb2RlanNGdW5jdGlvbiwgT3V0cHV0Rm9ybWF0IH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0IHsgS2luZXNpc0V2ZW50U291cmNlLCBTcXNEbHEgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLWV2ZW50LXNvdXJjZXMnO1xuaW1wb3J0IHsgU3RyZWFtLCBTdHJlYW1Nb2RlIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWtpbmVzaXMnO1xuaW1wb3J0IHtcbiAgRWZmZWN0LFxuICBJUm9sZSxcbiAgUG9saWN5U3RhdGVtZW50LFxuICBSb2xlLFxuICBTZXJ2aWNlUHJpbmNpcGFsLFxufSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCB7IFF1ZXVlIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLXNxcyc7XG5pbXBvcnQgeyBDZm5TY2hlZHVsZUdyb3VwIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLXNjaGVkdWxlcic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IERhdGFTdGFjayB9IGZyb20gJy4vZGF0YS1zdGFjayc7XG5pbXBvcnQgeyBBcGlTdGFjayB9IGZyb20gJy4vYXBpLXN0YWNrJztcblxuLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIEtpbmVzaXMgYmF0Y2gtY29uc3VtZXIgTGFtYmRhIGVudHJ5LiAqL1xuY29uc3QgS0lORVNJU19DT05TVU1FUl9FTlRSWSA9IHBhdGguam9pbihcbiAgX19kaXJuYW1lLFxuICAnLi4nLFxuICAnLi4nLFxuICAnaW5nZXN0JyxcbiAgJ3NyYycsXG4gICdraW5lc2lzSGFuZGxlci50cycsXG4pO1xuXG4vKipcbiAqIFRvZ2dsZSBmb3IgdGhlIGFsdGVybmF0aXZlIEtpbmVzaXMgRGF0YSBTdHJlYW1zIGluZ2VzdCBwYXRoXG4gKiAoZG9jcy9kZXNpZ24tc3FzLWZpZm8tYmF0Y2gtaW5nZXN0Lm1kKS4gU2V0IHZpYSBDREsgY29udGV4dFxuICogYC1jIGtpbmVzaXNJbmdlc3RNb2RlPTxtb2RlPmA6XG4gKiAgIC0gJ29mZicgICAgIChkZWZhdWx0KTogb25seSB0aGUgZGlyZWN0IEV2ZW50QnJpZGdlIC0+IExhbWJkYSBwYXRoIGV4aXN0cy5cbiAqICAgLSAncHJlc2VudCc6IEFMU08gcHJvdmlzaW9uIHRoZSBLaW5lc2lzIHN0cmVhbSArIGJhdGNoLWNvbnN1bWVyICsgZXZlbnQtXG4gKiAgICAgICAgICAgICAgICBzb3VyY2UgbWFwcGluZywgYnV0IEV2ZW50QnJpZGdlIHN0aWxsIHRhcmdldHMgdGhlIGluZ2VzdCBMYW1iZGFcbiAqICAgICAgICAgICAgICAgIGRpcmVjdGx5ICh0aGUgS2luZXNpcyBwYXRoIHNpdHMgaWRsZSDigJQgZGVwbG95L3ZhbGlkYXRlIHRoZVxuICogICAgICAgICAgICAgICAgcmVzb3VyY2VzIHdpdGhvdXQgY2hhbmdpbmcgbGl2ZSBpbmdlc3Rpb24pLlxuICogICAtICdhY3RpdmUnIDogRXZlbnRCcmlkZ2UgdGFyZ2V0cyB0aGUgS2luZXNpcyBzdHJlYW0gKFBhcnRpdGlvbktleSA9IHJ1bklkKVxuICogICAgICAgICAgICAgICAgaW5zdGVhZCBvZiB0aGUgTGFtYmRhICh0aGUgYmF0Y2gtY29uc3VtZXIgYmVjb21lcyB0aGUgbGl2ZVxuICogICAgICAgICAgICAgICAgaW5nZXN0IHBhdGgpLiBSb2xsIGJhY2sgdG8gJ3ByZXNlbnQnLydvZmYnIHdpdGggYSBzaW5nbGVcbiAqICAgICAgICAgICAgICAgIHJlLWRlcGxveSDigJQgbmVpdGhlciBwYXRoIGlzIGRlbGV0ZWQgb24gdGhlIHRvZ2dsZS5cbiAqXG4gKiBLaW5lc2lzIHdhcyBjaG9zZW4gb3ZlciBTUVMgRklGTyBiZWNhdXNlIEV2ZW50QnJpZGdlIC0+IEtpbmVzaXMgc3VwcG9ydHMgYVxuICogTkFUSVZFIGR5bmFtaWMgUGFydGl0aW9uS2V5IChgJC5kZXRhaWwucnVuSWRgKSwgZ2l2aW5nIHBlci1ydW4gb3JkZXJpbmcgd2l0aFxuICogTk8gZW5xdWV1ZSBMYW1iZGEgKG5vIGV4dHJhIGNvbmN1cnJlbmN5IHN1cmZhY2UpIGFuZCBOTyBicmlkZ2luZyBxdWV1ZS4gVGhlXG4gKiB0cmFkZW9mZiBpcyBLaW5lc2lzIGRvZXMgbm90IHNjYWxlIHRvIHplcm8gKH4kMzAvbW8gaWRsZSBmb3IgYW4gb24tZGVtYW5kXG4gKiBzdHJlYW0pLCBhY2NlcHRlZCBmb3IgdGhlIGxhcmdlLWJhdGNoIHRocm91Z2hwdXQgYW5kIGNsZWFuIHRvcG9sb2d5LlxuICovXG50eXBlIEtpbmVzaXNJbmdlc3RNb2RlID0gJ29mZicgfCAncHJlc2VudCcgfCAnYWN0aXZlJztcblxuLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIHJlY29uY2lsZXIgKGRlZmVycmVkIHJlLXN3ZWVwKSBMYW1iZGEgZW50cnkuICovXG5jb25zdCBSRUNPTkNJTEVSX0VOVFJZID0gcGF0aC5qb2luKFxuICBfX2Rpcm5hbWUsXG4gICcuLicsXG4gICcuLicsXG4gICdpbmdlc3QnLFxuICAnc3JjJyxcbiAgJ3JlY29uY2lsZXJIYW5kbGVyLnRzJyxcbik7XG5cbi8qKlxuICogQWJzb2x1dGUgcGF0aCB0byB0aGUgaW5nZXN0IExhbWJkYSBoYW5kbGVyIGVudHJ5IHBvaW50LiBUaGUgaGFuZGxlciBpcyBhbiBFU01cbiAqIFR5cGVTY3JpcHQgbW9kdWxlIGluIHRoZSBzaWJsaW5nIGBpbmdlc3QvYCBwYWNrYWdlOyBlc2J1aWxkIGJ1bmRsZXMgaXQgYXRcbiAqIHN5bnRoIHRpbWUuIFJlc29sdmVzIGNvcnJlY3RseSB1bmRlciBib3RoIGB0cy1ub2RlYCAoQ0RLIHN5bnRoKSBhbmQgYHRzY2BcbiAqIChjb21waWxlZCBgbGliL2ApIGJlY2F1c2UgYF9fZGlybmFtZWAgcG9pbnRzIGF0IGBpbmZyYS9saWJgLlxuICovXG5jb25zdCBIQU5ETEVSX0VOVFJZID0gcGF0aC5qb2luKFxuICBfX2Rpcm5hbWUsXG4gICcuLicsXG4gICcuLicsXG4gICdpbmdlc3QnLFxuICAnc3JjJyxcbiAgJ2hhbmRsZXIudHMnLFxuKTtcblxuLyoqXG4gKiBUaGUgaW5nZXN0IHBhY2thZ2UgZGlyZWN0b3J5IChzaWJsaW5nIG9mIGBpbmZyYS9gKSwgdXNlZCBhcyB0aGUgYnVuZGxpbmdcbiAqIHByb2plY3Qgcm9vdC4gVGhlIGhhbmRsZXIgbGl2ZXMgT1VUU0lERSB0aGUgYGluZnJhL2AgcGFja2FnZSwgc28gYGluZnJhL2Anc1xuICogbG9ja2ZpbGUg4oCUIHdoaWNoIGBOb2RlanNGdW5jdGlvbmAgd291bGQgb3RoZXJ3aXNlIGF1dG8tZGV0ZWN0IOKAlCBtYWtlcyB0aGVcbiAqIGVudHJ5IGFwcGVhciBvdXRzaWRlIHRoZSBwcm9qZWN0IHJvb3QuIFJvb3RpbmcgdGhlIGJ1bmRsZSBhdCB0aGUgaW5nZXN0XG4gKiBwYWNrYWdlIGl0c2VsZiBrZWVwcyBgZW50cnlgIHVuZGVyIHRoZSByb290IEFORCBydW5zIGVzYnVpbGQgaW4gYSBkaXJlY3RvcnlcbiAqIHdoZXJlIGl0IGlzIGluc3RhbGxlZCAoYGluZ2VzdC9ub2RlX21vZHVsZXNgKSwgc28gdGhlIGxvY2FsIGJ1bmRsZXIgcmVzb2x2ZXNcbiAqIGBucHggLS1uby1pbnN0YWxsIGVzYnVpbGRgIHdpdGhvdXQgRG9ja2VyLlxuICovXG5jb25zdCBJTkdFU1RfUFJPSkVDVF9ST09UID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJy4uJywgJ2luZ2VzdCcpO1xuXG4vKiogVGhlIGluZ2VzdCBwYWNrYWdlJ3MgbG9ja2ZpbGUsIHVzZWQgYXMgdGhlIGJ1bmRsaW5nIGRlcHMgbG9jayBmaWxlLiAqL1xuY29uc3QgSU5HRVNUX0RFUFNfTE9DS19GSUxFID0gcGF0aC5qb2luKFxuICBJTkdFU1RfUFJPSkVDVF9ST09ULFxuICAncGFja2FnZS1sb2NrLmpzb24nLFxuKTtcblxuLyoqIE1heGltdW0gRXZlbnRCcmlkZ2UgZGVsaXZlcnkgYXR0ZW1wdHMgYmVmb3JlIHJvdXRpbmcgdG8gdGhlIERMUSAoUmVxIDExLjMpLiAqL1xuY29uc3QgTUFYX0VWRU5UX1JFVFJZX0FUVEVNUFRTID0gMztcblxuZXhwb3J0IGludGVyZmFjZSBJbmdlc3RTdGFja1Byb3BzIGV4dGVuZHMgU3RhY2tQcm9wcyB7XG4gIC8qKiBUaGUgZGF0YSBsYXllciB0aGUgaW5nZXN0IExhbWJkYSB3cml0ZXMgdG8uICovXG4gIHJlYWRvbmx5IGRhdGFTdGFjazogRGF0YVN0YWNrO1xuICAvKiogVGhlIEFQSSB0aGUgaW5nZXN0IExhbWJkYSBwdWJsaXNoZXMgdXBkYXRlcyB0aHJvdWdoLiAqL1xuICByZWFkb25seSBhcGlTdGFjazogQXBpU3RhY2s7XG59XG5cbi8qKlxuICogSW5nZXN0U3RhY2sg4oCUIHRoZSBldmVudC1pbmdlc3QgbGF5ZXIuXG4gKlxuICogT3ducyB0aGUgaW5nZXN0IExhbWJkYSAoTm9kZWpzRnVuY3Rpb24gLyBlc2J1aWxkKSwgdGhlIEV2ZW50QnJpZGdlIHJ1bGUgb25cbiAqIHRoZSBkZWZhdWx0IGJ1cyAoc291cmNlID0gYXdzLm9taWNzKSwgdGhlIFNRUyBkZWFkLWxldHRlciBxdWV1ZSBhbmQgcmV0cnlcbiAqIHBvbGljeSwgYW5kIChpbiB0YXNrIDEwLjIpIGxlYXN0LXByaXZpbGVnZSBJQU0uXG4gKlxuICogRXZlbnQgc291cmNlIChkZXNpZ24ubWQgXCJJbmZyYXN0cnVjdHVyZSBhbmQgSUFNIOKGkiBFdmVudEJyaWRnZSwgRExRLCByZXRyeVwiKTpcbiAqICAgQSBydWxlIG9uIHRoZSBERUZBVUxUIGV2ZW50IGJ1cyB3aXRoIHBhdHRlcm4gYHtcInNvdXJjZVwiOiBbXCJhd3Mub21pY3NcIl19YFxuICogICAoUmVxIDEuMSkgdGFyZ2V0cyB0aGUgaW5nZXN0IExhbWJkYSB3aXRoIGEgcmV0cnkgcG9saWN5IG9mIGF0IG1vc3QgM1xuICogICBhdHRlbXB0cyAoUmVxIDExLjMpLCByb3V0aW5nIGRlbGl2ZXJpZXMgdGhhdCBzdGlsbCBmYWlsIHRvIHRoZSBTUVMgRExRXG4gKiAgIChSZXEgMS43KS5cbiAqXG4gKiBUaGUgaW5nZXN0IExhbWJkYSBpcyBhIE5vZGVqc0Z1bmN0aW9uOiBlc2J1aWxkIGJ1bmRsZXMgdGhlIEVTTSBUeXBlU2NyaXB0XG4gKiBoYW5kbGVyIGZvciB0aGUgTm9kZS5qcyAyMC54IHJ1bnRpbWUuIFRoZSBBV1MgU0RLIHYzIGNsaWVudHMgdGhlIGhhbmRsZXIgdXNlc1xuICogYXJlIHByb3ZpZGVkIGJ5IHRoZSBMYW1iZGEgcnVudGltZSwgc28gYEBhd3Mtc2RrLypgIGlzIG1hcmtlZCBleHRlcm5hbCByYXRoZXJcbiAqIHRoYW4gYnVuZGxlZC4gSXRzIHJlbmRlci9wdWJsaXNoIHRhcmdldHMgYXJlIHN1cHBsaWVkIGFzIGVudmlyb25tZW50XG4gKiB2YXJpYWJsZXMgKGBUQUJMRV9OQU1FYCwgYEFQUFNZTkNfRU5EUE9JTlRgKTsgYEFXU19SRUdJT05gIGlzIGluamVjdGVkIGJ5IHRoZVxuICogTGFtYmRhIHJ1bnRpbWUuXG4gKlxuICogVGhlIGluZ2VzdCBmdW5jdGlvbiBhbmQgaXRzIGV4ZWN1dGlvbiByb2xlIGFyZSBleHBvc2VkIGFzIHN0YWNrIHByb3BlcnRpZXMgc29cbiAqIHRhc2sgMTAuMiBjYW4gYXR0YWNoIHRoZSBEeW5hbW9EQiAvIEFwcFN5bmMgLyBIZWFsdGhPbWljcyBsZWFzdC1wcml2aWxlZ2VcbiAqIGdyYW50cyAoUmVxIDIuMywgNC40LCAxMS4yKSDigJQgZGVsaWJlcmF0ZWx5IE5PVCBncmFudGVkIGhlcmUuXG4gKlxuICogUmVxdWlyZW1lbnRzOiAxLjEsIDEuMiwgMS43LCAxMS4zICh0aGlzIHRhc2spOyAyLjMsIDQuNCwgMTEuMiAodGFzayAxMC4yKS5cbiAqL1xuZXhwb3J0IGNsYXNzIEluZ2VzdFN0YWNrIGV4dGVuZHMgU3RhY2sge1xuICAvKiogVGhlIGluZ2VzdCBMYW1iZGEgZnVuY3Rpb247IHRhc2sgMTAuMiBhdHRhY2hlcyBsZWFzdC1wcml2aWxlZ2UgSUFNIHRvIGl0LiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgaW5nZXN0RnVuY3Rpb246IE5vZGVqc0Z1bmN0aW9uO1xuXG4gIC8qKiBUaGUgaW5nZXN0IExhbWJkYSBleGVjdXRpb24gcm9sZSwgZXhwb3NlZCBmb3IgbGVhc3QtcHJpdmlsZWdlIGdyYW50cyAodGFzayAxMC4yKS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGluZ2VzdFJvbGU6IElSb2xlO1xuXG4gIC8qKiBUaGUgU1FTIGRlYWQtbGV0dGVyIHF1ZXVlIGNhcHR1cmluZyBkZWxpdmVyaWVzIHRoYXQgZmFpbCBhZnRlciByZXRyaWVzIChSZXEgMS43KS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGRlYWRMZXR0ZXJRdWV1ZTogUXVldWU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEluZ2VzdFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFNRUyBkZWFkLWxldHRlciBxdWV1ZSBmb3IgRXZlbnRCcmlkZ2UgZGVsaXZlcmllcyB0aGF0IHN0aWxsIGZhaWwgYWZ0ZXIgdGhlXG4gICAgLy8gY29uZmlndXJlZCByZXRyeSBhdHRlbXB0cyAoUmVxIDEuNykuXG4gICAgdGhpcy5kZWFkTGV0dGVyUXVldWUgPSBuZXcgUXVldWUodGhpcywgJ0luZ2VzdERscScsIHtcbiAgICAgIHJldGVudGlvblBlcmlvZDogRHVyYXRpb24uZGF5cygxNCksXG4gICAgfSk7XG5cbiAgICAvLyBUaGUgaW5nZXN0IExhbWJkYTogZXNidWlsZC1idW5kbGVkIEVTTSBUeXBlU2NyaXB0IG9uIE5vZGUuanMgMjAueC5cbiAgICAvL1xuICAgIC8vIElNUE9SVEFOVDogd2UgYnVuZGxlIG91ciBwaW5uZWQgYEBhd3Mtc2RrLypgIGNsaWVudHMgaW50byB0aGUgYXJ0aWZhY3RcbiAgICAvLyByYXRoZXIgdGhhbiByZWx5aW5nIG9uIHRoZSBTREsgYmFrZWQgaW50byB0aGUgTm9kZSAyMCBydW50aW1lLiBUaGUgcnVudGltZVxuICAgIC8vIFNESyBpcyBmcm96ZW4gYXQgYW4gb2xkZXIgdmVyc2lvbiB0aGF0IGRvZXMgbm90IGRlc2VyaWFsaXplIG5ld2VyIEdldFJ1blxuICAgIC8vIHJlc3BvbnNlIGZpZWxkcyAoZS5nLiBuZXR3b3JraW5nTW9kZSAvIGNvbmZpZ3VyYXRpb24gLyB2cGNDb25maWcpLCB3aGljaFxuICAgIC8vIHNpbGVudGx5IGRyb3BwZWQgdGhvc2UgZmllbGRzIGR1cmluZyBlbnJpY2htZW50LiBCdW5kbGluZyB0aGUgcGlubmVkXG4gICAgLy8gY2xpZW50ICgzLjExMTkuMCspIGVuc3VyZXMgdGhlIHJlc3BvbnNlIGlzIHBhcnNlZCB3aXRoIGEgY3VycmVudCBtb2RlbC5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdJbmdlc3RGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogSEFORExFUl9FTlRSWSxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIC8vIFRoZSBoYW5kbGVyIGxpdmVzIGluIHRoZSBzaWJsaW5nIGBpbmdlc3QvYCBwYWNrYWdlLCBvdXRzaWRlIGBpbmZyYS9gLlxuICAgICAgLy8gUm9vdCB0aGUgYnVuZGxlIGF0IHRoZSBpbmdlc3QgcGFja2FnZSBzbyB0aGUgZW50cnkgaXMgdW5kZXIgdGhlIHJvb3RcbiAgICAgIC8vIGFuZCBlc2J1aWxkIHJlc29sdmVzIGZyb20gYGluZ2VzdC9ub2RlX21vZHVsZXNgLlxuICAgICAgcHJvamVjdFJvb3Q6IElOR0VTVF9QUk9KRUNUX1JPT1QsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBJTkdFU1RfREVQU19MT0NLX0ZJTEUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIC8vIENPTkNVUlJFTkNZIC8gRU5SSUNITUVOVC1UUFMgU1BMSVQgKG9ubHkgZW5yaWNobWVudC1yZXF1aXJlZCBldmVudHMgYXJlXG4gICAgICAvLyByYXRlLWxpbWl0ZWQpLiBOb24tZW5yaWNoaW5nIHRhc2sgZXZlbnRzIChQRU5ESU5HL1NUQVJUSU5HL1NUT1BQSU5HKSBhbmRcbiAgICAgIC8vIG5vbi1lbnJpY2hpbmcgcnVuIGV2ZW50cyBkbyBOT1QgY2FsbCBhbnkgSGVhbHRoT21pY3MgcmVhZCBBUEkg4oCUIHRoZXkgYXJlXG4gICAgICAvLyBhIGNoZWFwIER5bmFtb0RCIHdyaXRlICsgQXBwU3luYyBwdWJsaXNoIOKAlCBzbyB0aGV5IG11c3QgTk9UIGJlIHN0YXJ2ZWQgYnlcbiAgICAgIC8vIHRoZSBlbnJpY2htZW50IHJhdGUgbGltaXQuIE9ubHkgUlVOTklORyArIHRlcm1pbmFsIHRhc2sgZXZlbnRzIChhbmQgcnVuXG4gICAgICAvLyBldmVudHMgbmVlZGluZyBHZXRSdW4pIGludm9rZSB0aGUgcGVyLWluc3RhbmNlIGBvbWljc1JhdGVMaW1pdGVyYC5cbiAgICAgIC8vXG4gICAgICAvLyBUaGUgZW5yaWNobWVudCBidWRnZXQgaXMgZW5mb3JjZWQgYXMgcmVzZXJ2ZWRDb25jdXJyZW5jeSDDlyBPTUlDU19UUFMg4omIXG4gICAgICAvLyB0aGUgSGVhbHRoT21pY3MgfjEwIFRQUyBydW4tcmVhZCBidWNrZXQgKDQwMCDDlyAwLjAyNSA9IDEwKSwgd2hpbGUgdGhlXG4gICAgICAvLyBISUdIIHJlc2VydmVkIGNvbmN1cnJlbmN5ICg0MDApIGxldHMgdGhlIGNoZWFwLCBub24tZW5yaWNoaW5nIG1ham9yaXR5XG4gICAgICAvLyAoUEVORElORy9TVEFSVElORyDigJQgRHluYW1vREIgd3JpdGUgKyBwdWJsaXNoLCBOTyBBUEkgY2FsbCkgZHJhaW4gZmFzdC5cbiAgICAgIC8vIEtFWSBQUk9QRVJUWTogYmVjYXVzZSBPTkxZIFJVTk5JTkcgKyB0ZXJtaW5hbCBldmVudHMgY2FsbCB0aGUgcmF0ZVxuICAgICAgLy8gbGltaXRlciwgcmFpc2luZyBjb25jdXJyZW5jeSB0byByZWxpZXZlIHRoZSBpbnZvY2F0aW9uLXRocm91Z2hwdXRcbiAgICAgIC8vIGJhY2tsb2cgZG9lcyBOT1QgaW5jcmVhc2UgSGVhbHRoT21pY3MgQVBJIHByZXNzdXJlIOKAlCB0aGUgVFBTIHN0YXlzXG4gICAgICAvLyBib3VuZGVkIGJ5IHRoZSBwcm9kdWN0LCB3aGljaCB3ZSBob2xkIGF0IDEwIGJ5IGxvd2VyaW5nIE9NSUNTX1RQUyBhcyB3ZVxuICAgICAgLy8gcmFpc2UgY29uY3VycmVuY3kuIDQwMCBjbGVhcnMgdGhlIH40LW1pbiBiYWNrbG9nIHNlZW4gd2hlbiBhbGwgMTAwIHJ1bnNcbiAgICAgIC8vIG9mIGEgYmF0Y2ggYXJlIHNpbXVsdGFuZW91c2x5IGFjdGl2ZTsgd2VsbCB1bmRlciBBcHBTeW5jJ3MgMTAsMDAwL3NlY1xuICAgICAgLy8gdG9rZW4gY2VpbGluZyBhbmQgbGVhdmVzIH41OTggb2YgMTAwMCBhY2NvdW50IGNvbmN1cnJlbmN5IHVucmVzZXJ2ZWQuXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiA0MDAsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAvLyBEeW5hbW9EQiBzaW5nbGUgdGFibGUgdGhlIGhhbmRsZXIgdXBzZXJ0cyBydW4vdGFzay9ncmFwaCBpdGVtcyBpbnRvLlxuICAgICAgICBUQUJMRV9OQU1FOiBwcm9wcy5kYXRhU3RhY2sudGFibGUudGFibGVOYW1lLFxuICAgICAgICAvLyBBcHBTeW5jIEdyYXBoUUwgZW5kcG9pbnQgdGhlIGhhbmRsZXIgcHVibGlzaGVzIHVwZGF0ZXMgdG8uIEFXU19SRUdJT05cbiAgICAgICAgLy8gaXMgcHJvdmlkZWQgYXV0b21hdGljYWxseSBieSB0aGUgTGFtYmRhIHJ1bnRpbWUgYW5kIGlzIHJlYWQgZGlyZWN0bHlcbiAgICAgICAgLy8gYnkgdGhlIGhhbmRsZXIgKGRvIG5vdCBzZXQgaXQgaGVyZSDigJQgaXQgaXMgYSByZXNlcnZlZCBlbnYgdmFyKS5cbiAgICAgICAgQVBQU1lOQ19FTkRQT0lOVDogcHJvcHMuYXBpU3RhY2suYXBpLmdyYXBocWxVcmwsXG4gICAgICAgIC8vIFBlci1pbnN0YW5jZSBIZWFsdGhPbWljcyByZWFkIHBhY2UuIE9ubHkgZW5yaWNoaW5nIGV2ZW50cyBjb25zdW1lIGl0O1xuICAgICAgICAvLyByZXNlcnZlZENvbmN1cnJlbmN5IMOXIE9NSUNTX1RQUyDiiYggdGhlIH4xMCBUUFMgcnVuLXJlYWQgYnVkZ2V0ICg0MDAgw5dcbiAgICAgICAgLy8gMC4wMjUpLiBMb3dlcmVkIGluIGxvY2stc3RlcCB3aXRoIHRoZSBjb25jdXJyZW5jeSByYWlzZSBzbyBBUEkgVFBTIGlzXG4gICAgICAgIC8vIHVuY2hhbmdlZC4gKFJhaXNlIHRvIDAuMDUgaWYvd2hlbiB0aGUgcnVuLXJlYWQgcXVvdGEgaXMgaW5jcmVhc2VkIHRvXG4gICAgICAgIC8vIDIwIFRQUy4pXG4gICAgICAgIE9NSUNTX1RQUzogJzAuMDI1JyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIC8vIEJ1bmRsZSB0aGUgQVdTIFNESyB2MyBjbGllbnRzIChkbyBOT1QgbWFyayB0aGVtIGV4dGVybmFsKSBzbyB0aGVcbiAgICAgICAgLy8gaGFuZGxlciB1c2VzIG91ciBwaW5uZWQsIGN1cnJlbnQgU0RLIHZlcnNpb25zIGluc3RlYWQgb2YgdGhlIG9sZGVyXG4gICAgICAgIC8vIFNESyBiYWtlZCBpbnRvIHRoZSBOb2RlIDIwIHJ1bnRpbWUg4oCUIHRoZSBzdGFsZSBydW50aW1lIFNESyBkcm9wcGVkXG4gICAgICAgIC8vIG5ld2VyIEdldFJ1biByZXNwb25zZSBmaWVsZHMgKG5ldHdvcmtpbmdNb2RlL2NvbmZpZ3VyYXRpb24vdnBjQ29uZmlnKS5cbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbXSxcbiAgICAgICAgLy8gVGhlIEFXUyBTREsgdjMgaW50ZXJuYWxseSB1c2VzIENvbW1vbkpTIGByZXF1aXJlKC4uLilgIChlLmcuXG4gICAgICAgIC8vIGBub2RlOmh0dHBzYCB2aWEgQHNtaXRoeSkuIEJ1bmRsaW5nIGl0IGludG8gYW4gRVNNIG91dHB1dCBtYWtlcyB0aG9zZVxuICAgICAgICAvLyBkeW5hbWljIHJlcXVpcmVzIGZhaWwgYXQgcnVudGltZSAoXCJEeW5hbWljIHJlcXVpcmUgb2YgLi4uIGlzIG5vdFxuICAgICAgICAvLyBzdXBwb3J0ZWRcIikuIEluamVjdCBhIGNyZWF0ZVJlcXVpcmUgc2hpbSBzbyB0aGUgYnVuZGxlZCBDSlMgbW9kdWxlc1xuICAgICAgICAvLyBjYW4gcmVzb2x2ZSB0aGVpciByZXF1aXJlcyB1bmRlciBFU00uXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBFeHBvc2UgdGhlIGF1dG8tY3JlYXRlZCBleGVjdXRpb24gcm9sZSBzbyB0YXNrIDEwLjIgY2FuIGF0dGFjaCB0aGVcbiAgICAvLyBEeW5hbW9EQiAvIEFwcFN5bmMgLyBIZWFsdGhPbWljcyBsZWFzdC1wcml2aWxlZ2UgZ3JhbnRzLlxuICAgIHRoaXMuaW5nZXN0Um9sZSA9IHRoaXMuaW5nZXN0RnVuY3Rpb24ucm9sZSE7XG5cbiAgICAvLyDilIDilIAgRGVmZXJyZWQgcmUtc3dlZXAgKFJlY29uY2lsZXIpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAgIC8vIEEgcnVuJ3MgUnVuX1N1bW1hcnkgaXMgY29tcHV0ZWQgYXQgdGhlIFRFUk1JTkFMIElOU1RBTlQsIGJlZm9yZSBDbG91ZFdhdGNoXG4gICAgLy8gdXRpbGl6YXRpb24gbWV0cmljcyBsYW5kIGFuZCBiZWZvcmUgYW55IG91dC1vZi1vcmRlciB0YXNrIHN0YXRlIHNldHRsZXMuXG4gICAgLy8gT24gdGVybWluYWwsIHRoZSBpbmdlc3QgY29tcGxldGlvbiBob29rIHNjaGVkdWxlcyBhIE9ORS1TSE9UIEV2ZW50QnJpZGdlXG4gICAgLy8gU2NoZWR1bGVyIH5SRUNPTkNJTEVfREVMQVlfTUlOVVRFUyBsYXRlciB0aGF0IGludm9rZXMgdGhpcyBSZWNvbmNpbGVyXG4gICAgLy8gTGFtYmRhLCB3aGljaCByZS1yZWFkcyB0aGUgYXV0aG9yaXRhdGl2ZSBydW4vdGFzayBzdGF0ZSArIHJlLXN3ZWVwc1xuICAgIC8vIENsb3VkV2F0Y2ggYW5kIHJlLXdyaXRlcyB0aGUgc3VtbWFyeSAoZm9yY2Utd2lubmluZyB0aGUgbW9ub3RvbmljIGd1YXJkKSxcbiAgICAvLyB0aGVuIGRlbGV0ZXMgaXRzIG93biBzY2hlZHVsZS4gTm90aGluZyBhY2N1bXVsYXRlcyAob25lLXNob3QgK1xuICAgIC8vIEFjdGlvbkFmdGVyQ29tcGxldGlvbi5ERUxFVEUgKyBzZWxmLWRlbGV0ZSkuXG4gICAgY29uc3QgcmVjb25jaWxlckZuID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdSZWNvbmNpbGVyRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBSdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgZW50cnk6IFJFQ09OQ0lMRVJfRU5UUlksXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBwcm9qZWN0Um9vdDogSU5HRVNUX1BST0pFQ1RfUk9PVCxcbiAgICAgIGRlcHNMb2NrRmlsZVBhdGg6IElOR0VTVF9ERVBTX0xPQ0tfRklMRSxcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoMzAwKSxcbiAgICAgIC8vIENhcCB0aGUgcmVjb25jaWxlIEZBTi1PVVQgc28gYSB3YXZlIG9mIHRlcm1pbmFsLXJ1biByZS1zd2VlcHMgc3RheXNcbiAgICAgIC8vIHdpdGhpbiB0aGUgSGVhbHRoT21pY3MgfjEwIFRQUyByZWFkIGJ1ZGdldCAodGhlIHBlci1pbnN0YW5jZSBsaW1pdGVyXG4gICAgICAvLyBwYWNlcyBvbmUgaW5zdGFuY2UsIG5vdCB0aGUgZmxlZXQpLiBUaGUgc3BsaXQgbXVzdCBBTFNPIGxldCBhIHNpbmdsZVxuICAgICAgLy8gcmVjb25jaWxlIG9mIGEgbGFyZ2UgcnVuICh+MjAwKyB0YXNrcywgb25lIEdldFJ1blRhc2sgZWFjaCkgZmluaXNoXG4gICAgICAvLyBpbnNpZGUgdGhlIExhbWJkYSB0aW1lb3V0OiBhdCBOIHRhc2tzIGFuZCBUIFRQUyBhIHN3ZWVwIHRha2VzIH5OL1Qgcy5cbiAgICAgIC8vIFdpdGggcmVzZXJ2ZWRDb25jdXJyZW5jeSAyIMOXIE9NSUNTX1RQUyA1ID0gfjEwIFRQUyBmbGVldCBidWRnZXQsIGFuZCBhXG4gICAgICAvLyBzaW5nbGUgaW5zdGFuY2UgYXQgNSBUUFMgZHJhaW5zIH4yMDAgdGFza3MgaW4gfjQwcyAod2VsbCB1bmRlciB0aGUgMzAwc1xuICAgICAgLy8gdGltZW91dCkuIERvIE5PVCBsb3dlciBPTUlDU19UUFMgdG8gMiB3aXRoIGEgMTIwcyB0aW1lb3V0IOKAlCBhIDIwNy10YXNrXG4gICAgICAvLyBydW4gdGhlbiBuZWVkcyB+MTAzcyBvZiBwdXJlIHBhY2luZyBhbmQgdGltZXMgb3V0IGJlZm9yZSBmaW5pc2hpbmdcbiAgICAgIC8vIChvYnNlcnZlZDogcmVjb25jaWxlcyBoaXQgU3RhdHVzOnRpbWVvdXQgYW5kIG5ldmVyIHJlY29uY2lsZWQgdGhlIHJ1bikuXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiAyLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgUkVDT05DSUxFUl9UQUJMRV9OQU1FOiBwcm9wcy5kYXRhU3RhY2sudGFibGUudGFibGVOYW1lLFxuICAgICAgICBNT05JVE9SSU5HX0hPU1Q6IGBtb25pdG9yaW5nLiR7U3RhY2sub2YodGhpcykucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgU0lHTklOR19TRVJWSUNFOiAnbW9uaXRvcmluZycsXG4gICAgICAgIC8vIFBlci1pbnN0YW5jZSBIZWFsdGhPbWljcyByZWFkIHBhY2U7IHJlc2VydmVkQ29uY3VycmVuY3kgw5cgT01JQ1NfVFBTIOKJiFxuICAgICAgICAvLyB0aGUgfjEwIFRQUyBhY2NvdW50IGJ1ZGdldCwgd2hpbGUgNSBUUFMga2VlcHMgYSBsYXJnZS1ydW4gc3dlZXAgd2l0aGluXG4gICAgICAgIC8vIHRoZSB0aW1lb3V0LlxuICAgICAgICBPTUlDU19UUFM6ICc1JyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIC8vIEJ1bmRsZSB0aGUgcGlubmVkIEFXUyBTREsgY2xpZW50cyAoc2FtZSByYXRpb25hbGUgYXMgdGhlIGluZ2VzdCBmbjpcbiAgICAgICAgLy8gbmV3ZXIgR2V0UnVuIGZpZWxkcykgKyBzY2hlZHVsZXIvc2lnbmF0dXJlIGRlcHM7IGluamVjdCB0aGUgRVNNXG4gICAgICAgIC8vIGNyZWF0ZVJlcXVpcmUgc2hpbSBzbyBidW5kbGVkIENKUyBkeW5hbWljIHJlcXVpcmVzIHJlc29sdmUuXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogW10sXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBSZWNvbmNpbGVyIElBTSAobGVhc3QtcHJpdmlsZWdlLCBleHBsaWNpdCBhY3Rpb25zICsgc2NvcGVkIHJlc291cmNlcyk6XG4gICAgLy8gIC0gRHluYW1vREIgUlcgb24gdGhlIHRhYmxlICsgR1NJIChyZS11cHNlcnQgdGFza3Mvc3VtbWFyeS9yZWdpc3RyeSkuXG4gICAgcmVjb25jaWxlckZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcbiAgICAgICAgICAnZHluYW1vZGI6VXBkYXRlSXRlbScsXG4gICAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAgICdkeW5hbW9kYjpRdWVyeScsXG4gICAgICAgICAgJ2R5bmFtb2RiOkNvbmRpdGlvbkNoZWNrSXRlbScsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIHByb3BzLmRhdGFTdGFjay50YWJsZUFybixcbiAgICAgICAgICBwcm9wcy5kYXRhU3RhY2suZ3NpMUFybixcbiAgICAgICAgICBwcm9wcy5kYXRhU3RhY2suZ3NpMkFybixcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgLy8gIC0gSGVhbHRoT21pY3MgcmVhZC1vbmx5IChhdXRob3JpdGF0aXZlIHJ1bi90YXNrIHJlLWVucmljaG1lbnQpLlxuICAgIHJlY29uY2lsZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnb21pY3M6R2V0UnVuJyxcbiAgICAgICAgICAnb21pY3M6TGlzdFJ1blRhc2tzJyxcbiAgICAgICAgICAnb21pY3M6R2V0UnVuVGFzaycsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIFN0YWNrLm9mKHRoaXMpLmZvcm1hdEFybih7IHNlcnZpY2U6ICdvbWljcycsIHJlc291cmNlOiAncnVuJywgcmVzb3VyY2VOYW1lOiAnKicgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuICAgIC8vICAtIENsb3VkV2F0Y2ggUHJvbVFMIG1ldHJpYyByZWFkIChzYW1lIGRvY3VtZW50ZWQgUmVzb3VyY2U6KiBleGNlcHRpb24gYXNcbiAgICAvLyAgICB0aGUgbWV0cmljcyBMYW1iZGEg4oCUIEdldE1ldHJpY0RhdGEvTGlzdE1ldHJpY3MgZG8gbm90IHN1cHBvcnRcbiAgICAvLyAgICByZXNvdXJjZS1sZXZlbCBzY29waW5nOyBOT1QgYSB3aWxkY2FyZCBhY3Rpb24pLlxuICAgIHJlY29uY2lsZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnY2xvdWR3YXRjaDpHZXRNZXRyaWNEYXRhJywgJ2Nsb3Vkd2F0Y2g6TGlzdE1ldHJpY3MnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyBPbmUgZGVkaWNhdGVkIHNjaGVkdWxlciBncm91cCBob2xkcyBhbGwgb25lLXNob3QgcmUtc3dlZXAgc2NoZWR1bGVzLCBzb1xuICAgIC8vIERlbGV0ZVNjaGVkdWxlIGFuZCBDcmVhdGVTY2hlZHVsZSBjYW4gYmUgc2NvcGVkIHRvIHRoaXMgZ3JvdXAncyBBUk4gb25seS5cbiAgICBjb25zdCBzY2hlZHVsZUdyb3VwID0gbmV3IENmblNjaGVkdWxlR3JvdXAodGhpcywgJ1JlY29uY2lsZVNjaGVkdWxlR3JvdXAnLCB7XG4gICAgICBuYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tcmVzd2VlcGAsXG4gICAgfSk7XG4gICAgY29uc3QgeyByZWdpb24sIGFjY291bnQgfSA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGNvbnN0IHNjaGVkdWxlQXJuUGF0dGVybiA9IGBhcm46YXdzOnNjaGVkdWxlcjoke3JlZ2lvbn06JHthY2NvdW50fTpzY2hlZHVsZS8ke3NjaGVkdWxlR3JvdXAubmFtZX0vKmA7XG5cbiAgICAvLyAgLSBUaGUgcmVjb25jaWxlciBkZWxldGVzIGl0cyBvd24gb25lLXNob3Qgc2NoZWR1bGUgKHNjb3BlZCB0byB0aGUgZ3JvdXApLlxuICAgIHJlY29uY2lsZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnc2NoZWR1bGVyOkRlbGV0ZVNjaGVkdWxlJ10sXG4gICAgICAgIHJlc291cmNlczogW3NjaGVkdWxlQXJuUGF0dGVybl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gVGhlIHJvbGUgRXZlbnRCcmlkZ2UgU2NoZWR1bGVyIGFzc3VtZXMgdG8gSU5WT0tFIHRoZSByZWNvbmNpbGVyLiBUcnVzdCBpc1xuICAgIC8vIHNjb3BlZCB0byB0aGUgc2NoZWR1bGVyIHNlcnZpY2U7IHBlcm1pc3Npb24gaXMgb25seSBsYW1iZGE6SW52b2tlRnVuY3Rpb25cbiAgICAvLyBvbiB0aGUgcmVjb25jaWxlciBmdW5jdGlvbiBBUk4uXG4gICAgY29uc3Qgc2NoZWR1bGVySW52b2tlUm9sZSA9IG5ldyBSb2xlKHRoaXMsICdSZWNvbmNpbGVTY2hlZHVsZXJSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgU2VydmljZVByaW5jaXBhbCgnc2NoZWR1bGVyLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAnQXNzdW1lZCBieSBFdmVudEJyaWRnZSBTY2hlZHVsZXIgdG8gaW52b2tlIHRoZSBkZWZlcnJlZCByZS1zd2VlcCBSZWNvbmNpbGVyIExhbWJkYS4nLFxuICAgIH0pO1xuICAgIHJlY29uY2lsZXJGbi5ncmFudEludm9rZShzY2hlZHVsZXJJbnZva2VSb2xlKTtcblxuICAgIC8vIEluZ2VzdCByb2xlOiBjcmVhdGUgdGhlIG9uZS1zaG90IHNjaGVkdWxlcyAoc2NvcGVkIHRvIHRoZSBncm91cCkgYW5kIHBhc3NcbiAgICAvLyB0aGUgc2NoZWR1bGVyLWludm9rZSByb2xlIHRvIEV2ZW50QnJpZGdlIFNjaGVkdWxlci4gaWFtOlBhc3NSb2xlIGlzIHNjb3BlZFxuICAgIC8vIHRvIHRoYXQgc2luZ2xlIHJvbGUgYW5kIGNvbmRpdGlvbmVkIG9uIHRoZSBzY2hlZHVsZXIgc2VydmljZS5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydzY2hlZHVsZXI6Q3JlYXRlU2NoZWR1bGUnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbc2NoZWR1bGVBcm5QYXR0ZXJuXSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnaWFtOlBhc3NSb2xlJ10sXG4gICAgICAgIHJlc291cmNlczogW3NjaGVkdWxlckludm9rZVJvbGUucm9sZUFybl0sXG4gICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICBTdHJpbmdFcXVhbHM6IHsgJ2lhbTpQYXNzZWRUb1NlcnZpY2UnOiAnc2NoZWR1bGVyLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gV2lyZSB0aGUgZGVmZXJyZWQgcmUtc3dlZXAgaW50byB0aGUgaW5nZXN0IGZ1bmN0aW9uIHZpYSBlbnYgKHByZXNlbmNlIG9mXG4gICAgLy8gdGhlc2UgdHdvIGVuYWJsZXMgc2NoZWR1bGVSZWNvbmNpbGUgaW4gdGhlIGhhbmRsZXIg4oCUIHN0YWdlZCByb2xsb3V0KS5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uLmFkZEVudmlyb25tZW50KCdSRUNPTkNJTEVSX0ZVTkNUSU9OX0FSTicsIHJlY29uY2lsZXJGbi5mdW5jdGlvbkFybik7XG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbi5hZGRFbnZpcm9ubWVudCgnUkVDT05DSUxFUl9TQ0hFRFVMRVJfUk9MRV9BUk4nLCBzY2hlZHVsZXJJbnZva2VSb2xlLnJvbGVBcm4pO1xuICAgIHRoaXMuaW5nZXN0RnVuY3Rpb24uYWRkRW52aXJvbm1lbnQoJ1JFQ09OQ0lMRVJfU0NIRURVTEVfR1JPVVAnLCBzY2hlZHVsZUdyb3VwLm5hbWUhKTtcbiAgICAvLyBBbHNvIHRlbGwgdGhlIHJlY29uY2lsZXIgd2hpY2ggZ3JvdXAgaXRzIHNjaGVkdWxlcyBsaXZlIGluIChzZWxmLWRlbGV0ZSkuXG4gICAgcmVjb25jaWxlckZuLmFkZEVudmlyb25tZW50KCdSRUNPTkNJTEVSX1NDSEVEVUxFX0dST1VQJywgc2NoZWR1bGVHcm91cC5uYW1lISk7XG5cbiAgICAvLyBFdmVudEJyaWRnZSBydWxlIG9uIHRoZSBERUZBVUxUIGJ1cyBtYXRjaGluZyBIZWFsdGhPbWljcyBzdGF0ZS1jaGFuZ2VcbiAgICAvLyBldmVudHMgKFJlcSAxLjEpLiBPbWl0dGluZyBgZXZlbnRCdXNgIHRhcmdldHMgdGhlIGFjY291bnQncyBkZWZhdWx0IGJ1cyxcbiAgICAvLyB3aGljaCBpcyB3aGVyZSBIZWFsdGhPbWljcyBwdWJsaXNoZXMuXG4gICAgY29uc3QgcnVsZSA9IG5ldyBSdWxlKHRoaXMsICdPbWljc0V2ZW50UnVsZScsIHtcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAnUm91dGVzIEFXUyBIZWFsdGhPbWljcyBzdGF0ZS1jaGFuZ2UgZXZlbnRzIChzb3VyY2UgPSBhd3Mub21pY3MpIHRvIHRoZSBpbmdlc3QgcGF0aC4nLFxuICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgIHNvdXJjZTogWydhd3Mub21pY3MnXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyAtLS0gQWx0ZXJuYXRpdmUgS2luZXNpcyBEYXRhIFN0cmVhbXMgaW5nZXN0IHBhdGggKHRvZ2dsZS1hYmxlLCBhZGRpdGl2ZSkgLVxuICAgIC8vIFJlYWQgdGhlIG1vZGUgZnJvbSBDREsgY29udGV4dDsgZGVmYXVsdCAnb2ZmJy4gV2hlbiAncHJlc2VudCcvJ2FjdGl2ZScgd2VcbiAgICAvLyBwcm92aXNpb24gdGhlIEtpbmVzaXMgc3RyZWFtICsgYmF0Y2gtY29uc3VtZXIgTGFtYmRhICsgZXZlbnQtc291cmNlXG4gICAgLy8gbWFwcGluZyBBTE9OR1NJREUgdGhlIGRpcmVjdCBwYXRoLiBUaGUgRXZlbnRCcmlkZ2UgdGFyZ2V0IGlzIHRoZSBMYW1iZGFcbiAgICAvLyBVTkxFU1MgbW9kZSBpcyAnYWN0aXZlJywgaW4gd2hpY2ggY2FzZSBpdCBpcyB0aGUgS2luZXNpcyBzdHJlYW0gKHdpdGggYVxuICAgIC8vIG5hdGl2ZSBkeW5hbWljIFBhcnRpdGlvbktleSA9ICQuZGV0YWlsLnJ1bklkKS4gRGVwbG95IGlkbGUgKCdwcmVzZW50JyksXG4gICAgLy8gY3V0IG92ZXIgKCdhY3RpdmUnKSwgYW5kIHJvbGwgYmFjayDigJQgYSBzaW5nbGUgY29udGV4dCBjaGFuZ2UgKyByZWRlcGxveSxcbiAgICAvLyBkZWxldGluZyBuZWl0aGVyIHBhdGguXG4gICAgY29uc3Qga2luZXNpc01vZGUgPVxuICAgICAgKHRoaXMubm9kZS50cnlHZXRDb250ZXh0KCdraW5lc2lzSW5nZXN0TW9kZScpIGFzIEtpbmVzaXNJbmdlc3RNb2RlKSA/PyAnb2ZmJztcbiAgICBpZiAoa2luZXNpc01vZGUgIT09ICdvZmYnKSB7XG4gICAgICB0aGlzLmJ1aWxkS2luZXNpc0luZ2VzdFBhdGgocHJvcHMsIHJ1bGUsIGtpbmVzaXNNb2RlKTtcbiAgICB9XG5cbiAgICAvLyBUaGUgZGlyZWN0IEV2ZW50QnJpZGdlIC0+IExhbWJkYSB0YXJnZXQgaXMgdXNlZCB1bmxlc3MgdGhlIEtpbmVzaXMgcGF0aCBpc1xuICAgIC8vIHRoZSBBQ1RJVkUgb25lIChpbiB3aGljaCBjYXNlIGJ1aWxkS2luZXNpc0luZ2VzdFBhdGggd2lyZWQgdGhlIHN0cmVhbSBhc1xuICAgIC8vIHRoZSB0YXJnZXQpLlxuICAgIGlmIChraW5lc2lzTW9kZSAhPT0gJ2FjdGl2ZScpIHtcbiAgICAgIC8vIFRhcmdldCB0aGUgaW5nZXN0IExhbWJkYSB3aXRoIGEgcmV0cnkgcG9saWN5IG9mIGF0IG1vc3QgMyBhdHRlbXB0c1xuICAgICAgLy8gKFJlcSAxMS4zKTsgZGVsaXZlcmllcyB0aGF0IHN0aWxsIGZhaWwgYXJlIHJvdXRlZCB0byB0aGUgRExRIChSZXEgMS43KS5cbiAgICAgIHJ1bGUuYWRkVGFyZ2V0KFxuICAgICAgICBuZXcgTGFtYmRhRnVuY3Rpb24odGhpcy5pbmdlc3RGdW5jdGlvbiwge1xuICAgICAgICAgIHJldHJ5QXR0ZW1wdHM6IE1BWF9FVkVOVF9SRVRSWV9BVFRFTVBUUyxcbiAgICAgICAgICBkZWFkTGV0dGVyUXVldWU6IHRoaXMuZGVhZExldHRlclF1ZXVlLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gLS0tIExlYXN0LXByaXZpbGVnZSBJQU0gZm9yIHRoZSBpbmdlc3Qgcm9sZSAoUmVxIDIuMywgNC40LCAxMS4yKSAtLS1cbiAgICAvLyBFdmVyeSBzdGF0ZW1lbnQgYmVsb3cgaXMgc2NvcGVkIHRvIGV4cGxpY2l0IGFjdGlvbiBsaXN0cyBhbmQgZXhwbGljaXRcbiAgICAvLyByZXNvdXJjZSBBUk5zLiBUaGVyZSBpcyBOTyBgQWN0aW9uOiBcIipcImAgYW5kIE5PIGBSZXNvdXJjZTogXCIqXCJgIGFueXdoZXJlXG4gICAgLy8gKFJlcSAxMS4yKS5cblxuICAgIC8vIER5bmFtb0RCOiB0aGUgaGFuZGxlciB1cHNlcnRzIHJ1bi90YXNrL2dyYXBoIGl0ZW1zIChQdXRJdGVtL1VwZGF0ZUl0ZW1cbiAgICAvLyB3aXRoIGEgbW9ub3RvbmljIGB1cGRhdGVkQXRgIGNvbmRpdGlvbmFsIGd1YXJkKSwgcmVhZHMgYSBjYWNoZWQgc3RhdGljXG4gICAgLy8gZ3JhcGggKEdldEl0ZW0pLCBhbmQgbWF5IFF1ZXJ5LiBTY29wZSB0byB0aGUgdGFibGUgYW5kIGl0cyBHU0kxIEFSTnMgb25seVxuICAgIC8vIChkZXNpZ24ubWQgXCJEeW5hbW9EQiB3cml0ZSBzY29wZWQgdG8gdGhlIHRhYmxlL0dTSSBBUk5zXCIpLiBDb25kaXRpb25DaGVja0l0ZW1cbiAgICAvLyBjb3ZlcnMgdGhlIHN0YWxlLXdyaXRlIGNvbmRpdGlvbmFsIGd1YXJkLlxuICAgIHRoaXMuaW5nZXN0RnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2R5bmFtb2RiOlB1dEl0ZW0nLFxuICAgICAgICAgICdkeW5hbW9kYjpVcGRhdGVJdGVtJyxcbiAgICAgICAgICAnZHluYW1vZGI6R2V0SXRlbScsXG4gICAgICAgICAgJ2R5bmFtb2RiOlF1ZXJ5JyxcbiAgICAgICAgICAnZHluYW1vZGI6Q29uZGl0aW9uQ2hlY2tJdGVtJyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbcHJvcHMuZGF0YVN0YWNrLnRhYmxlQXJuLCBwcm9wcy5kYXRhU3RhY2suZ3NpMUFybl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gQXBwU3luYzogdGhlIGhhbmRsZXIgaW52b2tlcyB0aGUgSUFNLWF1dGhvcml6ZWQgcHVibGlzaCBtdXRhdGlvbnMgb25seS5cbiAgICAvLyBTY29wZSBgYXBwc3luYzpHcmFwaFFMYCB0byB0aGUgdHdvIHB1Ymxpc2ggZmllbGQgQVJOcyDigJQgbm90IHRoZSB3aG9sZSBBUElcbiAgICAvLyAoUmVxIDQuNCkuIEZpZWxkIEFSTnMgYXJlIGRlcml2ZWQgZnJvbSB0aGUgQVBJJ3MgQVJOICh3aGljaCBlbmNvZGVzIHRoZVxuICAgIC8vIEFQSSBpZCkgd2l0aCB0aGUgR3JhcGhRTCBmaWVsZCBwYXRoIGFwcGVuZGVkLlxuICAgIGNvbnN0IHB1Ymxpc2hGaWVsZEFybnMgPSBbXG4gICAgICAncHVibGlzaFJ1blVwZGF0ZScsXG4gICAgICAncHVibGlzaFRhc2tVcGRhdGUnLFxuICAgIF0ubWFwKChmaWVsZCkgPT4gYCR7cHJvcHMuYXBpU3RhY2suYXBpLmFybn0vdHlwZXMvTXV0YXRpb24vZmllbGRzLyR7ZmllbGR9YCk7XG5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydhcHBzeW5jOkdyYXBoUUwnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBwdWJsaXNoRmllbGRBcm5zLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIEhlYWx0aE9taWNzOiBldmVudC10cmlnZ2VyZWQgcmVhZCBlbnJpY2htZW50IG9ubHkg4oCUIEdldFJ1biwgTGlzdFJ1blRhc2tzLFxuICAgIC8vIEdldFJ1blRhc2ssIEdldFdvcmtmbG93LiBObyBjcmVhdGUvdXBkYXRlL2RlbGV0ZSBhY3Rpb25zIChSZXEgMi4zKS4gU2NvcGVcbiAgICAvLyB0byB0aGlzIGFjY291bnQvcmVnaW9uJ3MgcnVuIGFuZCB3b3JrZmxvdyByZXNvdXJjZXMgcmF0aGVyIHRoYW4gYSB3aWxkY2FyZFxuICAgIC8vIHJlc291cmNlIChSZXEgMTEuMikuXG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnb21pY3M6R2V0UnVuJyxcbiAgICAgICAgICAnb21pY3M6TGlzdFJ1blRhc2tzJyxcbiAgICAgICAgICAnb21pY3M6R2V0UnVuVGFzaycsXG4gICAgICAgICAgJ29taWNzOkdldFdvcmtmbG93JyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgU3RhY2sub2YodGhpcykuZm9ybWF0QXJuKHtcbiAgICAgICAgICAgIHNlcnZpY2U6ICdvbWljcycsXG4gICAgICAgICAgICByZXNvdXJjZTogJ3J1bicsXG4gICAgICAgICAgICByZXNvdXJjZU5hbWU6ICcqJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBTdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oe1xuICAgICAgICAgICAgc2VydmljZTogJ29taWNzJyxcbiAgICAgICAgICAgIHJlc291cmNlOiAnd29ya2Zsb3cnLFxuICAgICAgICAgICAgcmVzb3VyY2VOYW1lOiAnKicsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gU3RhY2sgb3V0cHV0cyBzbyB0aGUgRExRIGFuZCBmdW5jdGlvbiBhcmUgZGlzY292ZXJhYmxlL29wZXJhYmxlIChSZXEgMTEuNykuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnSW5nZXN0RnVuY3Rpb25OYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuaW5nZXN0RnVuY3Rpb24uZnVuY3Rpb25OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdOYW1lIG9mIHRoZSBpbmdlc3QgTGFtYmRhIGZ1bmN0aW9uLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSW5nZXN0RnVuY3Rpb25OYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0RlYWRMZXR0ZXJRdWV1ZVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRlYWRMZXR0ZXJRdWV1ZS5xdWV1ZVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVVJMIG9mIHRoZSBpbmdlc3QgZGVhZC1sZXR0ZXIgcXVldWUuJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1EZWFkTGV0dGVyUXVldWVVcmxgLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFByb3Zpc2lvbiB0aGUgYWx0ZXJuYXRpdmUgS2luZXNpcyBEYXRhIFN0cmVhbXMgaW5nZXN0IHBhdGggKGFkZGl0aXZlLFxuICAgKiB0b2dnbGUtYWJsZSkuXG4gICAqXG4gICAqIENyZWF0ZXM6IGFuIG9uLWRlbWFuZCBLaW5lc2lzIHN0cmVhbSwgYSBiYXRjaC1jb25zdW1lciBMYW1iZGEgcmV1c2luZyB0aGVcbiAgICogaW5nZXN0IGhhbmRsZXIgcGlwZWxpbmUgKHZpYSBraW5lc2lzSGFuZGxlci50cyDihpIgZ2V0RGVmYXVsdEhhbmRsZXIpLCBhbmQgdGhlXG4gICAqIEtpbmVzaXMgZXZlbnQtc291cmNlIG1hcHBpbmcgd2l0aCBSZXBvcnRCYXRjaEl0ZW1GYWlsdXJlcyArIGJpc2VjdC1vbi1lcnJvclxuICAgKiArIGEgYm91bmRlZCByZXRyeS9hZ2UgYW5kIGFuIG9uLWZhaWx1cmUgRExRLiBXaGVuIGBtb2RlID09PSAnYWN0aXZlJ2AsIHRoZVxuICAgKiBwYXNzZWQgRXZlbnRCcmlkZ2UgcnVsZSB0YXJnZXRzIHRoZSBzdHJlYW0gd2l0aCBhIE5BVElWRSBkeW5hbWljXG4gICAqIFBhcnRpdGlvbktleSAoYCQuZGV0YWlsLnJ1bklkYCkgc28gYWxsIG9mIGEgcnVuJ3MgZXZlbnRzIGxhbmQgb24gb25lIHNoYXJkXG4gICAqIChpbi1vcmRlciBwZXIgcnVuLCBwYXJhbGxlbCBhY3Jvc3MgcnVucykuIFdoZW4gbWVyZWx5ICdwcmVzZW50JywgdGhlIHN0cmVhbVxuICAgKiBpcyBpZGxlIGFuZCB0aGUgY2FsbGVyIGtlZXBzIHRoZSBkaXJlY3QgTGFtYmRhIHRhcmdldC5cbiAgICpcbiAgICogQ29uc3VtZXIgc2NhbGluZzogS2luZXNpcyBjb25zdW1lciBjb25jdXJyZW5jeSA9IHNoYXJkcyDDlyBwYXJhbGxlbGl6YXRpb25cbiAgICogZmFjdG9yLiBPcmRlcmluZyBjb3JyZWN0bmVzcyByZW1haW5zIGF0IHRoZSBEeW5hbW9EQiBtb25vdG9uaWMgKyBzdGF0dXNcbiAgICogZ3VhcmRzIChwZXItc2hhcmQgb3JkZXIgcmVkdWNlcyByZW9yZGVyaW5nIGJ1dCBpcyBub3QgcmVsaWVkIHVwb24pLiBUaGVcbiAgICogdGVybWluYWwtb25seSBlbnJpY2htZW50IGdvdmVybm9yIChwZXItaW5zdGFuY2UgbGltaXRlcikga2VlcHMgR2V0UnVuVGFza1xuICAgKiB3aXRoaW4gdGhlIH4xMCBUUFMgSGVhbHRoT21pY3MgYnVja2V0IHJlZ2FyZGxlc3Mgb2Ygc2hhcmQgZmFuLW91dC5cbiAgICovXG4gIHByaXZhdGUgYnVpbGRLaW5lc2lzSW5nZXN0UGF0aChcbiAgICBwcm9wczogSW5nZXN0U3RhY2tQcm9wcyxcbiAgICBydWxlOiBSdWxlLFxuICAgIG1vZGU6IEtpbmVzaXNJbmdlc3RNb2RlLFxuICApOiB2b2lkIHtcbiAgICAvLyBPbi1kZW1hbmQgS2luZXNpcyBzdHJlYW06IGF1dG8tc2NhbGVzIHNoYXJkcyB3aXRoIHRocm91Z2hwdXQgKG5vIGNhcGFjaXR5XG4gICAgLy8gcGxhbm5pbmcpLCBiaWxscyBwZXItaG91ciArIHBlci1wYXlsb2FkIChkb2VzIE5PVCBzY2FsZSB0byB6ZXJvIOKAlCB0aGVcbiAgICAvLyBhY2NlcHRlZCB0cmFkZW9mZikuIFJldGFpbiBldmVudHMgZm9yIHRoZSBkZWZhdWx0IDI0aCBzbyBhIGNvbnN1bWVyIGlzc3VlXG4gICAgLy8gY2FuIGJlIHJlcGxheWVkLlxuICAgIGNvbnN0IHN0cmVhbSA9IG5ldyBTdHJlYW0odGhpcywgJ0luZ2VzdEtpbmVzaXNTdHJlYW0nLCB7XG4gICAgICBzdHJlYW1Nb2RlOiBTdHJlYW1Nb2RlLk9OX0RFTUFORCxcbiAgICAgIHJldGVudGlvblBlcmlvZDogRHVyYXRpb24uaG91cnMoMjQpLFxuICAgIH0pO1xuXG4gICAgLy8gT24tZmFpbHVyZSBETFEgZm9yIHJlY29yZHMgdGhhdCBleGhhdXN0IHJldHJpZXMgKHBvaXNvbiByZWNvcmRzKSwgc28gYSBiYWRcbiAgICAvLyByZWNvcmQgZG9lcyBub3QgYmxvY2sgaXRzIHNoYXJkIGluZGVmaW5pdGVseS5cbiAgICBjb25zdCBraW5lc2lzRGxxID0gbmV3IFF1ZXVlKHRoaXMsICdJbmdlc3RLaW5lc2lzRGxxJywge1xuICAgICAgcmV0ZW50aW9uUGVyaW9kOiBEdXJhdGlvbi5kYXlzKDE0KSxcbiAgICB9KTtcblxuICAgIC8vIEJhdGNoLWNvbnN1bWVyIExhbWJkYSDigJQgcmV1c2VzIHRoZSBleGFjdCBpbmdlc3QgcGlwZWxpbmUgKGtpbmVzaXNIYW5kbGVyLnRzXG4gICAgLy8g4oaSIGdldERlZmF1bHRIYW5kbGVyKS4gU2FtZSBlbnYgYXMgdGhlIGRpcmVjdCBpbmdlc3QgZnVuY3Rpb24gc28gYm90aCBwYXRoc1xuICAgIC8vIGJlaGF2ZSBpZGVudGljYWxseSBkb3duc3RyZWFtLlxuICAgIGNvbnN0IGNvbnN1bWVyID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdLaW5lc2lzSW5nZXN0Q29uc3VtZXInLCB7XG4gICAgICBydW50aW1lOiBSdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgZW50cnk6IEtJTkVTSVNfQ09OU1VNRVJfRU5UUlksXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBwcm9qZWN0Um9vdDogSU5HRVNUX1BST0pFQ1RfUk9PVCxcbiAgICAgIGRlcHNMb2NrRmlsZVBhdGg6IElOR0VTVF9ERVBTX0xPQ0tfRklMRSxcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoNjApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEFCTEVfTkFNRTogcHJvcHMuZGF0YVN0YWNrLnRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQVBQU1lOQ19FTkRQT0lOVDogcHJvcHMuYXBpU3RhY2suYXBpLmdyYXBocWxVcmwsXG4gICAgICAgIC8vIFBlci1pbnN0YW5jZSBIZWFsdGhPbWljcyByZWFkIHBhY2UgZ292ZXJub3IgKGVucmljaG1lbnQgVFBTKTsga2VlcHNcbiAgICAgICAgLy8gdGVybWluYWwgR2V0UnVuVGFzayB3aXRoaW4gdGhlIH4xMCBUUFMgYnVja2V0IHJlZ2FyZGxlc3Mgb2Ygc2hhcmRzLlxuICAgICAgICBPTUlDU19UUFM6ICcyJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogW10sXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDb25zdW1lciBsZWFzdC1wcml2aWxlZ2U6IHNhbWUgZG93bnN0cmVhbSBncmFudHMgYXMgdGhlIGRpcmVjdCBpbmdlc3RcbiAgICAvLyByb2xlIChEeW5hbW9EQiBSVyBvbiB0YWJsZStHU0kxLCBBcHBTeW5jIHB1Ymxpc2gsIEhlYWx0aE9taWNzIHJlYWQpLlxuICAgIGNvbnN1bWVyLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcbiAgICAgICAgICAnZHluYW1vZGI6VXBkYXRlSXRlbScsXG4gICAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAgICdkeW5hbW9kYjpRdWVyeScsXG4gICAgICAgICAgJ2R5bmFtb2RiOkNvbmRpdGlvbkNoZWNrSXRlbScsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW3Byb3BzLmRhdGFTdGFjay50YWJsZUFybiwgcHJvcHMuZGF0YVN0YWNrLmdzaTFBcm5dLFxuICAgICAgfSksXG4gICAgKTtcbiAgICBjb25zdCBwdWJsaXNoRmllbGRBcm5zID0gWydwdWJsaXNoUnVuVXBkYXRlJywgJ3B1Ymxpc2hUYXNrVXBkYXRlJ10ubWFwKFxuICAgICAgKGZpZWxkKSA9PiBgJHtwcm9wcy5hcGlTdGFjay5hcGkuYXJufS90eXBlcy9NdXRhdGlvbi9maWVsZHMvJHtmaWVsZH1gLFxuICAgICk7XG4gICAgY29uc3VtZXIuYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbJ2FwcHN5bmM6R3JhcGhRTCddLFxuICAgICAgICByZXNvdXJjZXM6IHB1Ymxpc2hGaWVsZEFybnMsXG4gICAgICB9KSxcbiAgICApO1xuICAgIGNvbnN1bWVyLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydvbWljczpHZXRSdW4nLCAnb21pY3M6TGlzdFJ1blRhc2tzJywgJ29taWNzOkdldFJ1blRhc2snLCAnb21pY3M6R2V0V29ya2Zsb3cnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgU3RhY2sub2YodGhpcykuZm9ybWF0QXJuKHsgc2VydmljZTogJ29taWNzJywgcmVzb3VyY2U6ICdydW4nLCByZXNvdXJjZU5hbWU6ICcqJyB9KSxcbiAgICAgICAgICBTdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oeyBzZXJ2aWNlOiAnb21pY3MnLCByZXNvdXJjZTogJ3dvcmtmbG93JywgcmVzb3VyY2VOYW1lOiAnKicgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gRXZlbnQtc291cmNlIG1hcHBpbmc6IGJhdGNoIHBlci1zaGFyZCBpbnRvIHRoZSBjb25zdW1lciwgcmVwb3J0IHBhcnRpYWxcbiAgICAvLyBmYWlsdXJlcyAocmV0cnkgZnJvbSB0aGUgZWFybGllc3QgZmFpbGVkIHNlcXVlbmNlKSwgYmlzZWN0IG9uIGVycm9yIHRvXG4gICAgLy8gaXNvbGF0ZSBhIHBvaXNvbiByZWNvcmQsIGJvdW5kIHJldHJpZXMvYWdlLCBhbmQgcm91dGUgZXhoYXVzdGVkIHJlY29yZHNcbiAgICAvLyB0byB0aGUgRExRLiBgS2luZXNpc0V2ZW50U291cmNlYCBncmFudHMgdGhlIGNvbnN1bWVyIGtpbmVzaXMgcmVhZCBvbiB0aGVcbiAgICAvLyBzdHJlYW0gYXV0b21hdGljYWxseS5cbiAgICBjb25zdW1lci5hZGRFdmVudFNvdXJjZShcbiAgICAgIG5ldyBLaW5lc2lzRXZlbnRTb3VyY2Uoc3RyZWFtLCB7XG4gICAgICAgIHN0YXJ0aW5nUG9zaXRpb246IFN0YXJ0aW5nUG9zaXRpb24uTEFURVNULFxuICAgICAgICBiYXRjaFNpemU6IDEwMCxcbiAgICAgICAgcmVwb3J0QmF0Y2hJdGVtRmFpbHVyZXM6IHRydWUsXG4gICAgICAgIGJpc2VjdEJhdGNoT25FcnJvcjogdHJ1ZSxcbiAgICAgICAgcmV0cnlBdHRlbXB0czogNSxcbiAgICAgICAgbWF4UmVjb3JkQWdlOiBEdXJhdGlvbi5ob3VycygxKSxcbiAgICAgICAgb25GYWlsdXJlOiBuZXcgU3FzRGxxKGtpbmVzaXNEbHEpLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIFdoZW4gQUNUSVZFLCBFdmVudEJyaWRnZSBkZWxpdmVycyB0byB0aGUgS2luZXNpcyBzdHJlYW0gd2l0aCBhIGR5bmFtaWNcbiAgICAvLyBQYXJ0aXRpb25LZXkgPSBydW5JZCAobmF0aXZlIHBhdGgtYmFzZWQga2V5KS4gV2hlbiBtZXJlbHkgUFJFU0VOVCwgdGhlXG4gICAgLy8gc3RyZWFtIGlzIGlkbGUgYW5kIHRoZSBjYWxsZXIga2VlcHMgdGhlIGRpcmVjdCBMYW1iZGEgdGFyZ2V0LlxuICAgIGlmIChtb2RlID09PSAnYWN0aXZlJykge1xuICAgICAgcnVsZS5hZGRUYXJnZXQoXG4gICAgICAgIG5ldyBLaW5lc2lzU3RyZWFtVGFyZ2V0KHN0cmVhbSwge1xuICAgICAgICAgIHBhcnRpdGlvbktleVBhdGg6ICckLmRldGFpbC5ydW5JZCcsXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdJbmdlc3RLaW5lc2lzU3RyZWFtTmFtZScsIHtcbiAgICAgIHZhbHVlOiBzdHJlYW0uc3RyZWFtTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTmFtZSBvZiB0aGUgS2luZXNpcyBpbmdlc3Qgc3RyZWFtIChhbHRlcm5hdGl2ZSBwYXRoKS4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUluZ2VzdEtpbmVzaXNTdHJlYW1OYW1lYCxcbiAgICB9KTtcbiAgfVxufVxuIl19