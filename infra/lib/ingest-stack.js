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
const aws_iam_1 = require("aws-cdk-lib/aws-iam");
const aws_sqs_1 = require("aws-cdk-lib/aws-sqs");
const aws_scheduler_1 = require("aws-cdk-lib/aws-scheduler");
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
            // Cap concurrency so the FLEET of ingest instances cannot collectively
            // exceed the HealthOmics ~10 TPS read budget: each instance paces its own
            // enrichment calls to OMICS_TPS (below), and reservedConcurrency ×
            // OMICS_TPS ≈ the account budget. This is the batch-scale safeguard — a
            // burst of several-thousand-run events queues in EventBridge and is
            // drained at a safe rate rather than self-inflicting a throttling storm.
            // (5 instances × 2 TPS = ~10 TPS.)
            reservedConcurrentExecutions: 5,
            environment: {
                // DynamoDB single table the handler upserts run/task/graph items into.
                TABLE_NAME: props.dataStack.table.tableName,
                // AppSync GraphQL endpoint the handler publishes updates to. AWS_REGION
                // is provided automatically by the Lambda runtime and is read directly
                // by the handler (do not set it here — it is a reserved env var).
                APPSYNC_ENDPOINT: props.apiStack.api.graphqlUrl,
                // Per-instance HealthOmics read-API pace (transactions/sec). With
                // reservedConcurrentExecutions above, the fleet stays within the ~10 TPS
                // account budget.
                OMICS_TPS: '2',
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
            timeout: aws_cdk_lib_1.Duration.seconds(120),
            environment: {
                RECONCILER_TABLE_NAME: props.dataStack.table.tableName,
                MONITORING_HOST: `monitoring.${aws_cdk_lib_1.Stack.of(this).region}.amazonaws.com`,
                SIGNING_SERVICE: 'monitoring',
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
            description: 'Routes AWS HealthOmics state-change events (source = aws.omics) to the ingest Lambda.',
            eventPattern: {
                source: ['aws.omics'],
            },
        });
        // Target the ingest Lambda with a retry policy of at most 3 attempts
        // (Req 11.3); deliveries that still fail are routed to the DLQ (Req 1.7).
        rule.addTarget(new aws_events_targets_1.LambdaFunction(this.ingestFunction, {
            retryAttempts: MAX_EVENT_RETRY_ATTEMPTS,
            deadLetterQueue: this.deadLetterQueue,
        }));
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
}
exports.IngestStack = IngestStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5nZXN0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiaW5nZXN0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDJDQUE2QjtBQUM3Qiw2Q0FBcUU7QUFDckUsdURBQThDO0FBQzlDLHVFQUFnRTtBQUNoRSx1REFBaUQ7QUFDakQscUVBQTZFO0FBQzdFLGlEQU02QjtBQUM3QixpREFBNEM7QUFDNUMsNkRBQTZEO0FBSzdELHdFQUF3RTtBQUN4RSxNQUFNLGdCQUFnQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQ2hDLFNBQVMsRUFDVCxJQUFJLEVBQ0osSUFBSSxFQUNKLFFBQVEsRUFDUixLQUFLLEVBQ0wsc0JBQXNCLENBQ3ZCLENBQUM7QUFFRjs7Ozs7R0FLRztBQUNILE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQzdCLFNBQVMsRUFDVCxJQUFJLEVBQ0osSUFBSSxFQUNKLFFBQVEsRUFDUixLQUFLLEVBQ0wsWUFBWSxDQUNiLENBQUM7QUFFRjs7Ozs7Ozs7R0FRRztBQUNILE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztBQUV2RSwwRUFBMEU7QUFDMUUsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUNyQyxtQkFBbUIsRUFDbkIsbUJBQW1CLENBQ3BCLENBQUM7QUFFRixrRkFBa0Y7QUFDbEYsTUFBTSx3QkFBd0IsR0FBRyxDQUFDLENBQUM7QUFTbkM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F5Qkc7QUFDSCxNQUFhLFdBQVksU0FBUSxtQkFBSztJQUNwQyxnRkFBZ0Y7SUFDaEUsY0FBYyxDQUFpQjtJQUUvQyx3RkFBd0Y7SUFDeEUsVUFBVSxDQUFRO0lBRWxDLHdGQUF3RjtJQUN4RSxlQUFlLENBQVE7SUFFdkMsWUFB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cGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24sIFN0YWNrLCBTdGFja1Byb3BzIH0gZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgUnVsZSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMnO1xuaW1wb3J0IHsgTGFtYmRhRnVuY3Rpb24gfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZXZlbnRzLXRhcmdldHMnO1xuaW1wb3J0IHsgUnVudGltZSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgTm9kZWpzRnVuY3Rpb24sIE91dHB1dEZvcm1hdCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCB7XG4gIEVmZmVjdCxcbiAgSVJvbGUsXG4gIFBvbGljeVN0YXRlbWVudCxcbiAgUm9sZSxcbiAgU2VydmljZVByaW5jaXBhbCxcbn0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgeyBRdWV1ZSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zcXMnO1xuaW1wb3J0IHsgQ2ZuU2NoZWR1bGVHcm91cCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zY2hlZHVsZXInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBEYXRhU3RhY2sgfSBmcm9tICcuL2RhdGEtc3RhY2snO1xuaW1wb3J0IHsgQXBpU3RhY2sgfSBmcm9tICcuL2FwaS1zdGFjayc7XG5cbi8qKiBBYnNvbHV0ZSBwYXRoIHRvIHRoZSByZWNvbmNpbGVyIChkZWZlcnJlZCByZS1zd2VlcCkgTGFtYmRhIGVudHJ5LiAqL1xuY29uc3QgUkVDT05DSUxFUl9FTlRSWSA9IHBhdGguam9pbihcbiAgX19kaXJuYW1lLFxuICAnLi4nLFxuICAnLi4nLFxuICAnaW5nZXN0JyxcbiAgJ3NyYycsXG4gICdyZWNvbmNpbGVySGFuZGxlci50cycsXG4pO1xuXG4vKipcbiAqIEFic29sdXRlIHBhdGggdG8gdGhlIGluZ2VzdCBMYW1iZGEgaGFuZGxlciBlbnRyeSBwb2ludC4gVGhlIGhhbmRsZXIgaXMgYW4gRVNNXG4gKiBUeXBlU2NyaXB0IG1vZHVsZSBpbiB0aGUgc2libGluZyBgaW5nZXN0L2AgcGFja2FnZTsgZXNidWlsZCBidW5kbGVzIGl0IGF0XG4gKiBzeW50aCB0aW1lLiBSZXNvbHZlcyBjb3JyZWN0bHkgdW5kZXIgYm90aCBgdHMtbm9kZWAgKENESyBzeW50aCkgYW5kIGB0c2NgXG4gKiAoY29tcGlsZWQgYGxpYi9gKSBiZWNhdXNlIGBfX2Rpcm5hbWVgIHBvaW50cyBhdCBgaW5mcmEvbGliYC5cbiAqL1xuY29uc3QgSEFORExFUl9FTlRSWSA9IHBhdGguam9pbihcbiAgX19kaXJuYW1lLFxuICAnLi4nLFxuICAnLi4nLFxuICAnaW5nZXN0JyxcbiAgJ3NyYycsXG4gICdoYW5kbGVyLnRzJyxcbik7XG5cbi8qKlxuICogVGhlIGluZ2VzdCBwYWNrYWdlIGRpcmVjdG9yeSAoc2libGluZyBvZiBgaW5mcmEvYCksIHVzZWQgYXMgdGhlIGJ1bmRsaW5nXG4gKiBwcm9qZWN0IHJvb3QuIFRoZSBoYW5kbGVyIGxpdmVzIE9VVFNJREUgdGhlIGBpbmZyYS9gIHBhY2thZ2UsIHNvIGBpbmZyYS9gJ3NcbiAqIGxvY2tmaWxlIOKAlCB3aGljaCBgTm9kZWpzRnVuY3Rpb25gIHdvdWxkIG90aGVyd2lzZSBhdXRvLWRldGVjdCDigJQgbWFrZXMgdGhlXG4gKiBlbnRyeSBhcHBlYXIgb3V0c2lkZSB0aGUgcHJvamVjdCByb290LiBSb290aW5nIHRoZSBidW5kbGUgYXQgdGhlIGluZ2VzdFxuICogcGFja2FnZSBpdHNlbGYga2VlcHMgYGVudHJ5YCB1bmRlciB0aGUgcm9vdCBBTkQgcnVucyBlc2J1aWxkIGluIGEgZGlyZWN0b3J5XG4gKiB3aGVyZSBpdCBpcyBpbnN0YWxsZWQgKGBpbmdlc3Qvbm9kZV9tb2R1bGVzYCksIHNvIHRoZSBsb2NhbCBidW5kbGVyIHJlc29sdmVzXG4gKiBgbnB4IC0tbm8taW5zdGFsbCBlc2J1aWxkYCB3aXRob3V0IERvY2tlci5cbiAqL1xuY29uc3QgSU5HRVNUX1BST0pFQ1RfUk9PVCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICcuLicsICdpbmdlc3QnKTtcblxuLyoqIFRoZSBpbmdlc3QgcGFja2FnZSdzIGxvY2tmaWxlLCB1c2VkIGFzIHRoZSBidW5kbGluZyBkZXBzIGxvY2sgZmlsZS4gKi9cbmNvbnN0IElOR0VTVF9ERVBTX0xPQ0tfRklMRSA9IHBhdGguam9pbihcbiAgSU5HRVNUX1BST0pFQ1RfUk9PVCxcbiAgJ3BhY2thZ2UtbG9jay5qc29uJyxcbik7XG5cbi8qKiBNYXhpbXVtIEV2ZW50QnJpZGdlIGRlbGl2ZXJ5IGF0dGVtcHRzIGJlZm9yZSByb3V0aW5nIHRvIHRoZSBETFEgKFJlcSAxMS4zKS4gKi9cbmNvbnN0IE1BWF9FVkVOVF9SRVRSWV9BVFRFTVBUUyA9IDM7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5nZXN0U3RhY2tQcm9wcyBleHRlbmRzIFN0YWNrUHJvcHMge1xuICAvKiogVGhlIGRhdGEgbGF5ZXIgdGhlIGluZ2VzdCBMYW1iZGEgd3JpdGVzIHRvLiAqL1xuICByZWFkb25seSBkYXRhU3RhY2s6IERhdGFTdGFjaztcbiAgLyoqIFRoZSBBUEkgdGhlIGluZ2VzdCBMYW1iZGEgcHVibGlzaGVzIHVwZGF0ZXMgdGhyb3VnaC4gKi9cbiAgcmVhZG9ubHkgYXBpU3RhY2s6IEFwaVN0YWNrO1xufVxuXG4vKipcbiAqIEluZ2VzdFN0YWNrIOKAlCB0aGUgZXZlbnQtaW5nZXN0IGxheWVyLlxuICpcbiAqIE93bnMgdGhlIGluZ2VzdCBMYW1iZGEgKE5vZGVqc0Z1bmN0aW9uIC8gZXNidWlsZCksIHRoZSBFdmVudEJyaWRnZSBydWxlIG9uXG4gKiB0aGUgZGVmYXVsdCBidXMgKHNvdXJjZSA9IGF3cy5vbWljcyksIHRoZSBTUVMgZGVhZC1sZXR0ZXIgcXVldWUgYW5kIHJldHJ5XG4gKiBwb2xpY3ksIGFuZCAoaW4gdGFzayAxMC4yKSBsZWFzdC1wcml2aWxlZ2UgSUFNLlxuICpcbiAqIEV2ZW50IHNvdXJjZSAoZGVzaWduLm1kIFwiSW5mcmFzdHJ1Y3R1cmUgYW5kIElBTSDihpIgRXZlbnRCcmlkZ2UsIERMUSwgcmV0cnlcIik6XG4gKiAgIEEgcnVsZSBvbiB0aGUgREVGQVVMVCBldmVudCBidXMgd2l0aCBwYXR0ZXJuIGB7XCJzb3VyY2VcIjogW1wiYXdzLm9taWNzXCJdfWBcbiAqICAgKFJlcSAxLjEpIHRhcmdldHMgdGhlIGluZ2VzdCBMYW1iZGEgd2l0aCBhIHJldHJ5IHBvbGljeSBvZiBhdCBtb3N0IDNcbiAqICAgYXR0ZW1wdHMgKFJlcSAxMS4zKSwgcm91dGluZyBkZWxpdmVyaWVzIHRoYXQgc3RpbGwgZmFpbCB0byB0aGUgU1FTIERMUVxuICogICAoUmVxIDEuNykuXG4gKlxuICogVGhlIGluZ2VzdCBMYW1iZGEgaXMgYSBOb2RlanNGdW5jdGlvbjogZXNidWlsZCBidW5kbGVzIHRoZSBFU00gVHlwZVNjcmlwdFxuICogaGFuZGxlciBmb3IgdGhlIE5vZGUuanMgMjAueCBydW50aW1lLiBUaGUgQVdTIFNESyB2MyBjbGllbnRzIHRoZSBoYW5kbGVyIHVzZXNcbiAqIGFyZSBwcm92aWRlZCBieSB0aGUgTGFtYmRhIHJ1bnRpbWUsIHNvIGBAYXdzLXNkay8qYCBpcyBtYXJrZWQgZXh0ZXJuYWwgcmF0aGVyXG4gKiB0aGFuIGJ1bmRsZWQuIEl0cyByZW5kZXIvcHVibGlzaCB0YXJnZXRzIGFyZSBzdXBwbGllZCBhcyBlbnZpcm9ubWVudFxuICogdmFyaWFibGVzIChgVEFCTEVfTkFNRWAsIGBBUFBTWU5DX0VORFBPSU5UYCk7IGBBV1NfUkVHSU9OYCBpcyBpbmplY3RlZCBieSB0aGVcbiAqIExhbWJkYSBydW50aW1lLlxuICpcbiAqIFRoZSBpbmdlc3QgZnVuY3Rpb24gYW5kIGl0cyBleGVjdXRpb24gcm9sZSBhcmUgZXhwb3NlZCBhcyBzdGFjayBwcm9wZXJ0aWVzIHNvXG4gKiB0YXNrIDEwLjIgY2FuIGF0dGFjaCB0aGUgRHluYW1vREIgLyBBcHBTeW5jIC8gSGVhbHRoT21pY3MgbGVhc3QtcHJpdmlsZWdlXG4gKiBncmFudHMgKFJlcSAyLjMsIDQuNCwgMTEuMikg4oCUIGRlbGliZXJhdGVseSBOT1QgZ3JhbnRlZCBoZXJlLlxuICpcbiAqIFJlcXVpcmVtZW50czogMS4xLCAxLjIsIDEuNywgMTEuMyAodGhpcyB0YXNrKTsgMi4zLCA0LjQsIDExLjIgKHRhc2sgMTAuMikuXG4gKi9cbmV4cG9ydCBjbGFzcyBJbmdlc3RTdGFjayBleHRlbmRzIFN0YWNrIHtcbiAgLyoqIFRoZSBpbmdlc3QgTGFtYmRhIGZ1bmN0aW9uOyB0YXNrIDEwLjIgYXR0YWNoZXMgbGVhc3QtcHJpdmlsZWdlIElBTSB0byBpdC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGluZ2VzdEZ1bmN0aW9uOiBOb2RlanNGdW5jdGlvbjtcblxuICAvKiogVGhlIGluZ2VzdCBMYW1iZGEgZXhlY3V0aW9uIHJvbGUsIGV4cG9zZWQgZm9yIGxlYXN0LXByaXZpbGVnZSBncmFudHMgKHRhc2sgMTAuMikuICovXG4gIHB1YmxpYyByZWFkb25seSBpbmdlc3RSb2xlOiBJUm9sZTtcblxuICAvKiogVGhlIFNRUyBkZWFkLWxldHRlciBxdWV1ZSBjYXB0dXJpbmcgZGVsaXZlcmllcyB0aGF0IGZhaWwgYWZ0ZXIgcmV0cmllcyAoUmVxIDEuNykuICovXG4gIHB1YmxpYyByZWFkb25seSBkZWFkTGV0dGVyUXVldWU6IFF1ZXVlO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBJbmdlc3RTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBTUVMgZGVhZC1sZXR0ZXIgcXVldWUgZm9yIEV2ZW50QnJpZGdlIGRlbGl2ZXJpZXMgdGhhdCBzdGlsbCBmYWlsIGFmdGVyIHRoZVxuICAgIC8vIGNvbmZpZ3VyZWQgcmV0cnkgYXR0ZW1wdHMgKFJlcSAxLjcpLlxuICAgIHRoaXMuZGVhZExldHRlclF1ZXVlID0gbmV3IFF1ZXVlKHRoaXMsICdJbmdlc3REbHEnLCB7XG4gICAgICByZXRlbnRpb25QZXJpb2Q6IER1cmF0aW9uLmRheXMoMTQpLFxuICAgIH0pO1xuXG4gICAgLy8gVGhlIGluZ2VzdCBMYW1iZGE6IGVzYnVpbGQtYnVuZGxlZCBFU00gVHlwZVNjcmlwdCBvbiBOb2RlLmpzIDIwLnguXG4gICAgLy9cbiAgICAvLyBJTVBPUlRBTlQ6IHdlIGJ1bmRsZSBvdXIgcGlubmVkIGBAYXdzLXNkay8qYCBjbGllbnRzIGludG8gdGhlIGFydGlmYWN0XG4gICAgLy8gcmF0aGVyIHRoYW4gcmVseWluZyBvbiB0aGUgU0RLIGJha2VkIGludG8gdGhlIE5vZGUgMjAgcnVudGltZS4gVGhlIHJ1bnRpbWVcbiAgICAvLyBTREsgaXMgZnJvemVuIGF0IGFuIG9sZGVyIHZlcnNpb24gdGhhdCBkb2VzIG5vdCBkZXNlcmlhbGl6ZSBuZXdlciBHZXRSdW5cbiAgICAvLyByZXNwb25zZSBmaWVsZHMgKGUuZy4gbmV0d29ya2luZ01vZGUgLyBjb25maWd1cmF0aW9uIC8gdnBjQ29uZmlnKSwgd2hpY2hcbiAgICAvLyBzaWxlbnRseSBkcm9wcGVkIHRob3NlIGZpZWxkcyBkdXJpbmcgZW5yaWNobWVudC4gQnVuZGxpbmcgdGhlIHBpbm5lZFxuICAgIC8vIGNsaWVudCAoMy4xMTE5LjArKSBlbnN1cmVzIHRoZSByZXNwb25zZSBpcyBwYXJzZWQgd2l0aCBhIGN1cnJlbnQgbW9kZWwuXG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnSW5nZXN0RnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBSdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgZW50cnk6IEhBTkRMRVJfRU5UUlksXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICAvLyBUaGUgaGFuZGxlciBsaXZlcyBpbiB0aGUgc2libGluZyBgaW5nZXN0L2AgcGFja2FnZSwgb3V0c2lkZSBgaW5mcmEvYC5cbiAgICAgIC8vIFJvb3QgdGhlIGJ1bmRsZSBhdCB0aGUgaW5nZXN0IHBhY2thZ2Ugc28gdGhlIGVudHJ5IGlzIHVuZGVyIHRoZSByb290XG4gICAgICAvLyBhbmQgZXNidWlsZCByZXNvbHZlcyBmcm9tIGBpbmdlc3Qvbm9kZV9tb2R1bGVzYC5cbiAgICAgIHByb2plY3RSb290OiBJTkdFU1RfUFJPSkVDVF9ST09ULFxuICAgICAgZGVwc0xvY2tGaWxlUGF0aDogSU5HRVNUX0RFUFNfTE9DS19GSUxFLFxuICAgICAgdGltZW91dDogRHVyYXRpb24uc2Vjb25kcyg2MCksXG4gICAgICAvLyBDYXAgY29uY3VycmVuY3kgc28gdGhlIEZMRUVUIG9mIGluZ2VzdCBpbnN0YW5jZXMgY2Fubm90IGNvbGxlY3RpdmVseVxuICAgICAgLy8gZXhjZWVkIHRoZSBIZWFsdGhPbWljcyB+MTAgVFBTIHJlYWQgYnVkZ2V0OiBlYWNoIGluc3RhbmNlIHBhY2VzIGl0cyBvd25cbiAgICAgIC8vIGVucmljaG1lbnQgY2FsbHMgdG8gT01JQ1NfVFBTIChiZWxvdyksIGFuZCByZXNlcnZlZENvbmN1cnJlbmN5IMOXXG4gICAgICAvLyBPTUlDU19UUFMg4omIIHRoZSBhY2NvdW50IGJ1ZGdldC4gVGhpcyBpcyB0aGUgYmF0Y2gtc2NhbGUgc2FmZWd1YXJkIOKAlCBhXG4gICAgICAvLyBidXJzdCBvZiBzZXZlcmFsLXRob3VzYW5kLXJ1biBldmVudHMgcXVldWVzIGluIEV2ZW50QnJpZGdlIGFuZCBpc1xuICAgICAgLy8gZHJhaW5lZCBhdCBhIHNhZmUgcmF0ZSByYXRoZXIgdGhhbiBzZWxmLWluZmxpY3RpbmcgYSB0aHJvdHRsaW5nIHN0b3JtLlxuICAgICAgLy8gKDUgaW5zdGFuY2VzIMOXIDIgVFBTID0gfjEwIFRQUy4pXG4gICAgICByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zOiA1LFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgLy8gRHluYW1vREIgc2luZ2xlIHRhYmxlIHRoZSBoYW5kbGVyIHVwc2VydHMgcnVuL3Rhc2svZ3JhcGggaXRlbXMgaW50by5cbiAgICAgICAgVEFCTEVfTkFNRTogcHJvcHMuZGF0YVN0YWNrLnRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgLy8gQXBwU3luYyBHcmFwaFFMIGVuZHBvaW50IHRoZSBoYW5kbGVyIHB1Ymxpc2hlcyB1cGRhdGVzIHRvLiBBV1NfUkVHSU9OXG4gICAgICAgIC8vIGlzIHByb3ZpZGVkIGF1dG9tYXRpY2FsbHkgYnkgdGhlIExhbWJkYSBydW50aW1lIGFuZCBpcyByZWFkIGRpcmVjdGx5XG4gICAgICAgIC8vIGJ5IHRoZSBoYW5kbGVyIChkbyBub3Qgc2V0IGl0IGhlcmUg4oCUIGl0IGlzIGEgcmVzZXJ2ZWQgZW52IHZhcikuXG4gICAgICAgIEFQUFNZTkNfRU5EUE9JTlQ6IHByb3BzLmFwaVN0YWNrLmFwaS5ncmFwaHFsVXJsLFxuICAgICAgICAvLyBQZXItaW5zdGFuY2UgSGVhbHRoT21pY3MgcmVhZC1BUEkgcGFjZSAodHJhbnNhY3Rpb25zL3NlYykuIFdpdGhcbiAgICAgICAgLy8gcmVzZXJ2ZWRDb25jdXJyZW50RXhlY3V0aW9ucyBhYm92ZSwgdGhlIGZsZWV0IHN0YXlzIHdpdGhpbiB0aGUgfjEwIFRQU1xuICAgICAgICAvLyBhY2NvdW50IGJ1ZGdldC5cbiAgICAgICAgT01JQ1NfVFBTOiAnMicsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgZm9ybWF0OiBPdXRwdXRGb3JtYXQuRVNNLFxuICAgICAgICAvLyBCdW5kbGUgdGhlIEFXUyBTREsgdjMgY2xpZW50cyAoZG8gTk9UIG1hcmsgdGhlbSBleHRlcm5hbCkgc28gdGhlXG4gICAgICAgIC8vIGhhbmRsZXIgdXNlcyBvdXIgcGlubmVkLCBjdXJyZW50IFNESyB2ZXJzaW9ucyBpbnN0ZWFkIG9mIHRoZSBvbGRlclxuICAgICAgICAvLyBTREsgYmFrZWQgaW50byB0aGUgTm9kZSAyMCBydW50aW1lIOKAlCB0aGUgc3RhbGUgcnVudGltZSBTREsgZHJvcHBlZFxuICAgICAgICAvLyBuZXdlciBHZXRSdW4gcmVzcG9uc2UgZmllbGRzIChuZXR3b3JraW5nTW9kZS9jb25maWd1cmF0aW9uL3ZwY0NvbmZpZykuXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogW10sXG4gICAgICAgIC8vIFRoZSBBV1MgU0RLIHYzIGludGVybmFsbHkgdXNlcyBDb21tb25KUyBgcmVxdWlyZSguLi4pYCAoZS5nLlxuICAgICAgICAvLyBgbm9kZTpodHRwc2AgdmlhIEBzbWl0aHkpLiBCdW5kbGluZyBpdCBpbnRvIGFuIEVTTSBvdXRwdXQgbWFrZXMgdGhvc2VcbiAgICAgICAgLy8gZHluYW1pYyByZXF1aXJlcyBmYWlsIGF0IHJ1bnRpbWUgKFwiRHluYW1pYyByZXF1aXJlIG9mIC4uLiBpcyBub3RcbiAgICAgICAgLy8gc3VwcG9ydGVkXCIpLiBJbmplY3QgYSBjcmVhdGVSZXF1aXJlIHNoaW0gc28gdGhlIGJ1bmRsZWQgQ0pTIG1vZHVsZXNcbiAgICAgICAgLy8gY2FuIHJlc29sdmUgdGhlaXIgcmVxdWlyZXMgdW5kZXIgRVNNLlxuICAgICAgICBiYW5uZXI6XG4gICAgICAgICAgXCJpbXBvcnR7Y3JlYXRlUmVxdWlyZSBhcyBfX2NyZWF0ZVJlcXVpcmV9ZnJvbSdtb2R1bGUnO2NvbnN0IHJlcXVpcmU9X19jcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRXhwb3NlIHRoZSBhdXRvLWNyZWF0ZWQgZXhlY3V0aW9uIHJvbGUgc28gdGFzayAxMC4yIGNhbiBhdHRhY2ggdGhlXG4gICAgLy8gRHluYW1vREIgLyBBcHBTeW5jIC8gSGVhbHRoT21pY3MgbGVhc3QtcHJpdmlsZWdlIGdyYW50cy5cbiAgICB0aGlzLmluZ2VzdFJvbGUgPSB0aGlzLmluZ2VzdEZ1bmN0aW9uLnJvbGUhO1xuXG4gICAgLy8g4pSA4pSAIERlZmVycmVkIHJlLXN3ZWVwIChSZWNvbmNpbGVyKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAvLyBBIHJ1bidzIFJ1bl9TdW1tYXJ5IGlzIGNvbXB1dGVkIGF0IHRoZSBURVJNSU5BTCBJTlNUQU5ULCBiZWZvcmUgQ2xvdWRXYXRjaFxuICAgIC8vIHV0aWxpemF0aW9uIG1ldHJpY3MgbGFuZCBhbmQgYmVmb3JlIGFueSBvdXQtb2Ytb3JkZXIgdGFzayBzdGF0ZSBzZXR0bGVzLlxuICAgIC8vIE9uIHRlcm1pbmFsLCB0aGUgaW5nZXN0IGNvbXBsZXRpb24gaG9vayBzY2hlZHVsZXMgYSBPTkUtU0hPVCBFdmVudEJyaWRnZVxuICAgIC8vIFNjaGVkdWxlciB+UkVDT05DSUxFX0RFTEFZX01JTlVURVMgbGF0ZXIgdGhhdCBpbnZva2VzIHRoaXMgUmVjb25jaWxlclxuICAgIC8vIExhbWJkYSwgd2hpY2ggcmUtcmVhZHMgdGhlIGF1dGhvcml0YXRpdmUgcnVuL3Rhc2sgc3RhdGUgKyByZS1zd2VlcHNcbiAgICAvLyBDbG91ZFdhdGNoIGFuZCByZS13cml0ZXMgdGhlIHN1bW1hcnkgKGZvcmNlLXdpbm5pbmcgdGhlIG1vbm90b25pYyBndWFyZCksXG4gICAgLy8gdGhlbiBkZWxldGVzIGl0cyBvd24gc2NoZWR1bGUuIE5vdGhpbmcgYWNjdW11bGF0ZXMgKG9uZS1zaG90ICtcbiAgICAvLyBBY3Rpb25BZnRlckNvbXBsZXRpb24uREVMRVRFICsgc2VsZi1kZWxldGUpLlxuICAgIGNvbnN0IHJlY29uY2lsZXJGbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnUmVjb25jaWxlckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGVudHJ5OiBSRUNPTkNJTEVSX0VOVFJZLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgcHJvamVjdFJvb3Q6IElOR0VTVF9QUk9KRUNUX1JPT1QsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBJTkdFU1RfREVQU19MT0NLX0ZJTEUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDEyMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBSRUNPTkNJTEVSX1RBQkxFX05BTUU6IHByb3BzLmRhdGFTdGFjay50YWJsZS50YWJsZU5hbWUsXG4gICAgICAgIE1PTklUT1JJTkdfSE9TVDogYG1vbml0b3JpbmcuJHtTdGFjay5vZih0aGlzKS5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICAgICAgICBTSUdOSU5HX1NFUlZJQ0U6ICdtb25pdG9yaW5nJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIC8vIEJ1bmRsZSB0aGUgcGlubmVkIEFXUyBTREsgY2xpZW50cyAoc2FtZSByYXRpb25hbGUgYXMgdGhlIGluZ2VzdCBmbjpcbiAgICAgICAgLy8gbmV3ZXIgR2V0UnVuIGZpZWxkcykgKyBzY2hlZHVsZXIvc2lnbmF0dXJlIGRlcHM7IGluamVjdCB0aGUgRVNNXG4gICAgICAgIC8vIGNyZWF0ZVJlcXVpcmUgc2hpbSBzbyBidW5kbGVkIENKUyBkeW5hbWljIHJlcXVpcmVzIHJlc29sdmUuXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogW10sXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBSZWNvbmNpbGVyIElBTSAobGVhc3QtcHJpdmlsZWdlLCBleHBsaWNpdCBhY3Rpb25zICsgc2NvcGVkIHJlc291cmNlcyk6XG4gICAgLy8gIC0gRHluYW1vREIgUlcgb24gdGhlIHRhYmxlICsgR1NJIChyZS11cHNlcnQgdGFza3Mvc3VtbWFyeS9yZWdpc3RyeSkuXG4gICAgcmVjb25jaWxlckZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcbiAgICAgICAgICAnZHluYW1vZGI6VXBkYXRlSXRlbScsXG4gICAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAgICdkeW5hbW9kYjpRdWVyeScsXG4gICAgICAgICAgJ2R5bmFtb2RiOkNvbmRpdGlvbkNoZWNrSXRlbScsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIHByb3BzLmRhdGFTdGFjay50YWJsZUFybixcbiAgICAgICAgICBwcm9wcy5kYXRhU3RhY2suZ3NpMUFybixcbiAgICAgICAgICBwcm9wcy5kYXRhU3RhY2suZ3NpMkFybixcbiAgICAgICAgXSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgLy8gIC0gSGVhbHRoT21pY3MgcmVhZC1vbmx5IChhdXRob3JpdGF0aXZlIHJ1bi90YXNrIHJlLWVucmljaG1lbnQpLlxuICAgIHJlY29uY2lsZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnb21pY3M6R2V0UnVuJyxcbiAgICAgICAgICAnb21pY3M6TGlzdFJ1blRhc2tzJyxcbiAgICAgICAgICAnb21pY3M6R2V0UnVuVGFzaycsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW1xuICAgICAgICAgIFN0YWNrLm9mKHRoaXMpLmZvcm1hdEFybih7IHNlcnZpY2U6ICdvbWljcycsIHJlc291cmNlOiAncnVuJywgcmVzb3VyY2VOYW1lOiAnKicgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuICAgIC8vICAtIENsb3VkV2F0Y2ggUHJvbVFMIG1ldHJpYyByZWFkIChzYW1lIGRvY3VtZW50ZWQgUmVzb3VyY2U6KiBleGNlcHRpb24gYXNcbiAgICAvLyAgICB0aGUgbWV0cmljcyBMYW1iZGEg4oCUIEdldE1ldHJpY0RhdGEvTGlzdE1ldHJpY3MgZG8gbm90IHN1cHBvcnRcbiAgICAvLyAgICByZXNvdXJjZS1sZXZlbCBzY29waW5nOyBOT1QgYSB3aWxkY2FyZCBhY3Rpb24pLlxuICAgIHJlY29uY2lsZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnY2xvdWR3YXRjaDpHZXRNZXRyaWNEYXRhJywgJ2Nsb3Vkd2F0Y2g6TGlzdE1ldHJpY3MnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyBPbmUgZGVkaWNhdGVkIHNjaGVkdWxlciBncm91cCBob2xkcyBhbGwgb25lLXNob3QgcmUtc3dlZXAgc2NoZWR1bGVzLCBzb1xuICAgIC8vIERlbGV0ZVNjaGVkdWxlIGFuZCBDcmVhdGVTY2hlZHVsZSBjYW4gYmUgc2NvcGVkIHRvIHRoaXMgZ3JvdXAncyBBUk4gb25seS5cbiAgICBjb25zdCBzY2hlZHVsZUdyb3VwID0gbmV3IENmblNjaGVkdWxlR3JvdXAodGhpcywgJ1JlY29uY2lsZVNjaGVkdWxlR3JvdXAnLCB7XG4gICAgICBuYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tcmVzd2VlcGAsXG4gICAgfSk7XG4gICAgY29uc3QgeyByZWdpb24sIGFjY291bnQgfSA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGNvbnN0IHNjaGVkdWxlQXJuUGF0dGVybiA9IGBhcm46YXdzOnNjaGVkdWxlcjoke3JlZ2lvbn06JHthY2NvdW50fTpzY2hlZHVsZS8ke3NjaGVkdWxlR3JvdXAubmFtZX0vKmA7XG5cbiAgICAvLyAgLSBUaGUgcmVjb25jaWxlciBkZWxldGVzIGl0cyBvd24gb25lLXNob3Qgc2NoZWR1bGUgKHNjb3BlZCB0byB0aGUgZ3JvdXApLlxuICAgIHJlY29uY2lsZXJGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnc2NoZWR1bGVyOkRlbGV0ZVNjaGVkdWxlJ10sXG4gICAgICAgIHJlc291cmNlczogW3NjaGVkdWxlQXJuUGF0dGVybl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gVGhlIHJvbGUgRXZlbnRCcmlkZ2UgU2NoZWR1bGVyIGFzc3VtZXMgdG8gSU5WT0tFIHRoZSByZWNvbmNpbGVyLiBUcnVzdCBpc1xuICAgIC8vIHNjb3BlZCB0byB0aGUgc2NoZWR1bGVyIHNlcnZpY2U7IHBlcm1pc3Npb24gaXMgb25seSBsYW1iZGE6SW52b2tlRnVuY3Rpb25cbiAgICAvLyBvbiB0aGUgcmVjb25jaWxlciBmdW5jdGlvbiBBUk4uXG4gICAgY29uc3Qgc2NoZWR1bGVySW52b2tlUm9sZSA9IG5ldyBSb2xlKHRoaXMsICdSZWNvbmNpbGVTY2hlZHVsZXJSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgU2VydmljZVByaW5jaXBhbCgnc2NoZWR1bGVyLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAnQXNzdW1lZCBieSBFdmVudEJyaWRnZSBTY2hlZHVsZXIgdG8gaW52b2tlIHRoZSBkZWZlcnJlZCByZS1zd2VlcCBSZWNvbmNpbGVyIExhbWJkYS4nLFxuICAgIH0pO1xuICAgIHJlY29uY2lsZXJGbi5ncmFudEludm9rZShzY2hlZHVsZXJJbnZva2VSb2xlKTtcblxuICAgIC8vIEluZ2VzdCByb2xlOiBjcmVhdGUgdGhlIG9uZS1zaG90IHNjaGVkdWxlcyAoc2NvcGVkIHRvIHRoZSBncm91cCkgYW5kIHBhc3NcbiAgICAvLyB0aGUgc2NoZWR1bGVyLWludm9rZSByb2xlIHRvIEV2ZW50QnJpZGdlIFNjaGVkdWxlci4gaWFtOlBhc3NSb2xlIGlzIHNjb3BlZFxuICAgIC8vIHRvIHRoYXQgc2luZ2xlIHJvbGUgYW5kIGNvbmRpdGlvbmVkIG9uIHRoZSBzY2hlZHVsZXIgc2VydmljZS5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydzY2hlZHVsZXI6Q3JlYXRlU2NoZWR1bGUnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbc2NoZWR1bGVBcm5QYXR0ZXJuXSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnaWFtOlBhc3NSb2xlJ10sXG4gICAgICAgIHJlc291cmNlczogW3NjaGVkdWxlckludm9rZVJvbGUucm9sZUFybl0sXG4gICAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgICBTdHJpbmdFcXVhbHM6IHsgJ2lhbTpQYXNzZWRUb1NlcnZpY2UnOiAnc2NoZWR1bGVyLmFtYXpvbmF3cy5jb20nIH0sXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gV2lyZSB0aGUgZGVmZXJyZWQgcmUtc3dlZXAgaW50byB0aGUgaW5nZXN0IGZ1bmN0aW9uIHZpYSBlbnYgKHByZXNlbmNlIG9mXG4gICAgLy8gdGhlc2UgdHdvIGVuYWJsZXMgc2NoZWR1bGVSZWNvbmNpbGUgaW4gdGhlIGhhbmRsZXIg4oCUIHN0YWdlZCByb2xsb3V0KS5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uLmFkZEVudmlyb25tZW50KCdSRUNPTkNJTEVSX0ZVTkNUSU9OX0FSTicsIHJlY29uY2lsZXJGbi5mdW5jdGlvbkFybik7XG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbi5hZGRFbnZpcm9ubWVudCgnUkVDT05DSUxFUl9TQ0hFRFVMRVJfUk9MRV9BUk4nLCBzY2hlZHVsZXJJbnZva2VSb2xlLnJvbGVBcm4pO1xuICAgIHRoaXMuaW5nZXN0RnVuY3Rpb24uYWRkRW52aXJvbm1lbnQoJ1JFQ09OQ0lMRVJfU0NIRURVTEVfR1JPVVAnLCBzY2hlZHVsZUdyb3VwLm5hbWUhKTtcbiAgICAvLyBBbHNvIHRlbGwgdGhlIHJlY29uY2lsZXIgd2hpY2ggZ3JvdXAgaXRzIHNjaGVkdWxlcyBsaXZlIGluIChzZWxmLWRlbGV0ZSkuXG4gICAgcmVjb25jaWxlckZuLmFkZEVudmlyb25tZW50KCdSRUNPTkNJTEVSX1NDSEVEVUxFX0dST1VQJywgc2NoZWR1bGVHcm91cC5uYW1lISk7XG5cbiAgICAvLyBFdmVudEJyaWRnZSBydWxlIG9uIHRoZSBERUZBVUxUIGJ1cyBtYXRjaGluZyBIZWFsdGhPbWljcyBzdGF0ZS1jaGFuZ2VcbiAgICAvLyBldmVudHMgKFJlcSAxLjEpLiBPbWl0dGluZyBgZXZlbnRCdXNgIHRhcmdldHMgdGhlIGFjY291bnQncyBkZWZhdWx0IGJ1cyxcbiAgICAvLyB3aGljaCBpcyB3aGVyZSBIZWFsdGhPbWljcyBwdWJsaXNoZXMuXG4gICAgY29uc3QgcnVsZSA9IG5ldyBSdWxlKHRoaXMsICdPbWljc0V2ZW50UnVsZScsIHtcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAnUm91dGVzIEFXUyBIZWFsdGhPbWljcyBzdGF0ZS1jaGFuZ2UgZXZlbnRzIChzb3VyY2UgPSBhd3Mub21pY3MpIHRvIHRoZSBpbmdlc3QgTGFtYmRhLicsXG4gICAgICBldmVudFBhdHRlcm46IHtcbiAgICAgICAgc291cmNlOiBbJ2F3cy5vbWljcyddLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFRhcmdldCB0aGUgaW5nZXN0IExhbWJkYSB3aXRoIGEgcmV0cnkgcG9saWN5IG9mIGF0IG1vc3QgMyBhdHRlbXB0c1xuICAgIC8vIChSZXEgMTEuMyk7IGRlbGl2ZXJpZXMgdGhhdCBzdGlsbCBmYWlsIGFyZSByb3V0ZWQgdG8gdGhlIERMUSAoUmVxIDEuNykuXG4gICAgcnVsZS5hZGRUYXJnZXQoXG4gICAgICBuZXcgTGFtYmRhRnVuY3Rpb24odGhpcy5pbmdlc3RGdW5jdGlvbiwge1xuICAgICAgICByZXRyeUF0dGVtcHRzOiBNQVhfRVZFTlRfUkVUUllfQVRURU1QVFMsXG4gICAgICAgIGRlYWRMZXR0ZXJRdWV1ZTogdGhpcy5kZWFkTGV0dGVyUXVldWUsXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gLS0tIExlYXN0LXByaXZpbGVnZSBJQU0gZm9yIHRoZSBpbmdlc3Qgcm9sZSAoUmVxIDIuMywgNC40LCAxMS4yKSAtLS1cbiAgICAvLyBFdmVyeSBzdGF0ZW1lbnQgYmVsb3cgaXMgc2NvcGVkIHRvIGV4cGxpY2l0IGFjdGlvbiBsaXN0cyBhbmQgZXhwbGljaXRcbiAgICAvLyByZXNvdXJjZSBBUk5zLiBUaGVyZSBpcyBOTyBgQWN0aW9uOiBcIipcImAgYW5kIE5PIGBSZXNvdXJjZTogXCIqXCJgIGFueXdoZXJlXG4gICAgLy8gKFJlcSAxMS4yKS5cblxuICAgIC8vIER5bmFtb0RCOiB0aGUgaGFuZGxlciB1cHNlcnRzIHJ1bi90YXNrL2dyYXBoIGl0ZW1zIChQdXRJdGVtL1VwZGF0ZUl0ZW1cbiAgICAvLyB3aXRoIGEgbW9ub3RvbmljIGB1cGRhdGVkQXRgIGNvbmRpdGlvbmFsIGd1YXJkKSwgcmVhZHMgYSBjYWNoZWQgc3RhdGljXG4gICAgLy8gZ3JhcGggKEdldEl0ZW0pLCBhbmQgbWF5IFF1ZXJ5LiBTY29wZSB0byB0aGUgdGFibGUgYW5kIGl0cyBHU0kxIEFSTnMgb25seVxuICAgIC8vIChkZXNpZ24ubWQgXCJEeW5hbW9EQiB3cml0ZSBzY29wZWQgdG8gdGhlIHRhYmxlL0dTSSBBUk5zXCIpLiBDb25kaXRpb25DaGVja0l0ZW1cbiAgICAvLyBjb3ZlcnMgdGhlIHN0YWxlLXdyaXRlIGNvbmRpdGlvbmFsIGd1YXJkLlxuICAgIHRoaXMuaW5nZXN0RnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2R5bmFtb2RiOlB1dEl0ZW0nLFxuICAgICAgICAgICdkeW5hbW9kYjpVcGRhdGVJdGVtJyxcbiAgICAgICAgICAnZHluYW1vZGI6R2V0SXRlbScsXG4gICAgICAgICAgJ2R5bmFtb2RiOlF1ZXJ5JyxcbiAgICAgICAgICAnZHluYW1vZGI6Q29uZGl0aW9uQ2hlY2tJdGVtJyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbcHJvcHMuZGF0YVN0YWNrLnRhYmxlQXJuLCBwcm9wcy5kYXRhU3RhY2suZ3NpMUFybl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gQXBwU3luYzogdGhlIGhhbmRsZXIgaW52b2tlcyB0aGUgSUFNLWF1dGhvcml6ZWQgcHVibGlzaCBtdXRhdGlvbnMgb25seS5cbiAgICAvLyBTY29wZSBgYXBwc3luYzpHcmFwaFFMYCB0byB0aGUgdHdvIHB1Ymxpc2ggZmllbGQgQVJOcyDigJQgbm90IHRoZSB3aG9sZSBBUElcbiAgICAvLyAoUmVxIDQuNCkuIEZpZWxkIEFSTnMgYXJlIGRlcml2ZWQgZnJvbSB0aGUgQVBJJ3MgQVJOICh3aGljaCBlbmNvZGVzIHRoZVxuICAgIC8vIEFQSSBpZCkgd2l0aCB0aGUgR3JhcGhRTCBmaWVsZCBwYXRoIGFwcGVuZGVkLlxuICAgIGNvbnN0IHB1Ymxpc2hGaWVsZEFybnMgPSBbXG4gICAgICAncHVibGlzaFJ1blVwZGF0ZScsXG4gICAgICAncHVibGlzaFRhc2tVcGRhdGUnLFxuICAgIF0ubWFwKChmaWVsZCkgPT4gYCR7cHJvcHMuYXBpU3RhY2suYXBpLmFybn0vdHlwZXMvTXV0YXRpb24vZmllbGRzLyR7ZmllbGR9YCk7XG5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydhcHBzeW5jOkdyYXBoUUwnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBwdWJsaXNoRmllbGRBcm5zLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIEhlYWx0aE9taWNzOiBldmVudC10cmlnZ2VyZWQgcmVhZCBlbnJpY2htZW50IG9ubHkg4oCUIEdldFJ1biwgTGlzdFJ1blRhc2tzLFxuICAgIC8vIEdldFJ1blRhc2ssIEdldFdvcmtmbG93LiBObyBjcmVhdGUvdXBkYXRlL2RlbGV0ZSBhY3Rpb25zIChSZXEgMi4zKS4gU2NvcGVcbiAgICAvLyB0byB0aGlzIGFjY291bnQvcmVnaW9uJ3MgcnVuIGFuZCB3b3JrZmxvdyByZXNvdXJjZXMgcmF0aGVyIHRoYW4gYSB3aWxkY2FyZFxuICAgIC8vIHJlc291cmNlIChSZXEgMTEuMikuXG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnb21pY3M6R2V0UnVuJyxcbiAgICAgICAgICAnb21pY3M6TGlzdFJ1blRhc2tzJyxcbiAgICAgICAgICAnb21pY3M6R2V0UnVuVGFzaycsXG4gICAgICAgICAgJ29taWNzOkdldFdvcmtmbG93JyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgU3RhY2sub2YodGhpcykuZm9ybWF0QXJuKHtcbiAgICAgICAgICAgIHNlcnZpY2U6ICdvbWljcycsXG4gICAgICAgICAgICByZXNvdXJjZTogJ3J1bicsXG4gICAgICAgICAgICByZXNvdXJjZU5hbWU6ICcqJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBTdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oe1xuICAgICAgICAgICAgc2VydmljZTogJ29taWNzJyxcbiAgICAgICAgICAgIHJlc291cmNlOiAnd29ya2Zsb3cnLFxuICAgICAgICAgICAgcmVzb3VyY2VOYW1lOiAnKicsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gU3RhY2sgb3V0cHV0cyBzbyB0aGUgRExRIGFuZCBmdW5jdGlvbiBhcmUgZGlzY292ZXJhYmxlL29wZXJhYmxlIChSZXEgMTEuNykuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnSW5nZXN0RnVuY3Rpb25OYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuaW5nZXN0RnVuY3Rpb24uZnVuY3Rpb25OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdOYW1lIG9mIHRoZSBpbmdlc3QgTGFtYmRhIGZ1bmN0aW9uLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSW5nZXN0RnVuY3Rpb25OYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0RlYWRMZXR0ZXJRdWV1ZVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRlYWRMZXR0ZXJRdWV1ZS5xdWV1ZVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVVJMIG9mIHRoZSBpbmdlc3QgZGVhZC1sZXR0ZXIgcXVldWUuJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1EZWFkTGV0dGVyUXVldWVVcmxgLFxuICAgIH0pO1xuICB9XG59XG4iXX0=