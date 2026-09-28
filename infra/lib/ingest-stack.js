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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5nZXN0LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiaW5nZXN0LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDJDQUE2QjtBQUM3Qiw2Q0FBcUU7QUFDckUsdURBQThDO0FBQzlDLHVFQUFnRTtBQUNoRSx1REFBaUQ7QUFDakQscUVBQTZFO0FBQzdFLGlEQUFxRTtBQUNyRSxpREFBNEM7QUFLNUM7Ozs7O0dBS0c7QUFDSCxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUM3QixTQUFTLEVBQ1QsSUFBSSxFQUNKLElBQUksRUFDSixRQUFRLEVBQ1IsS0FBSyxFQUNMLFlBQVksQ0FDYixDQUFDO0FBRUY7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFNLG1CQUFtQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFFdkUsMEVBQTBFO0FBQzFFLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FDckMsbUJBQW1CLEVBQ25CLG1CQUFtQixDQUNwQixDQUFDO0FBRUYsa0ZBQWtGO0FBQ2xGLE1BQU0sd0JBQXdCLEdBQUcsQ0FBQyxDQUFDO0FBU25DOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBeUJHO0FBQ0gsTUFBYSxXQUFZLFNBQVEsbUJBQUs7SUFDcEMsZ0ZBQWdGO0lBQ2hFLGNBQWMsQ0FBaUI7SUFFL0Msd0ZBQXdGO0lBQ3hFLFVBQVUsQ0FBUTtJQUVsQyx3RkFBd0Y7SUFDeEUsZUFBZSxDQUFRO0lBRXZDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBdUI7UUFDL0QsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsNkVBQTZFO1FBQzdFLHVDQUF1QztRQUN2QyxJQUFJLENBQUMsZUFBZSxHQUFHLElBQUks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USxFQUFFLFVBQVU7b0JBQ3BCLFlBQVksRUFBRSxHQUFHO2lCQUNsQixDQUFDO2FBQ0g7U0FDRixDQUFDLENBQ0gsQ0FBQztRQUVGLDhFQUE4RTtRQUM5RSxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLFlBQVk7WUFDdkMsV0FBVyxFQUFFLHFDQUFxQztZQUNsRCxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxxQkFBcUI7U0FDbkQsQ0FBQyxDQUFDO1FBRUgsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRTtZQUN4QyxLQUFLLEVBQUUsSUFBSSxDQUFDLGVBQWUsQ0FBQyxRQUFRO1lBQ3BDLFdBQVcsRUFBRSxzQ0FBc0M7WUFDbkQsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMscUJBQXFCO1NBQ25ELENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXBMRCxrQ0FvTEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgQ2ZuT3V0cHV0LCBEdXJhdGlvbiwgU3RhY2ssIFN0YWNrUHJvcHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBSdWxlIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWV2ZW50cyc7XG5pbXBvcnQgeyBMYW1iZGFGdW5jdGlvbiB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1ldmVudHMtdGFyZ2V0cyc7XG5pbXBvcnQgeyBSdW50aW1lIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgeyBOb2RlanNGdW5jdGlvbiwgT3V0cHV0Rm9ybWF0IH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanMnO1xuaW1wb3J0IHsgRWZmZWN0LCBJUm9sZSwgUG9saWN5U3RhdGVtZW50IH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgeyBRdWV1ZSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zcXMnO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBEYXRhU3RhY2sgfSBmcm9tICcuL2RhdGEtc3RhY2snO1xuaW1wb3J0IHsgQXBpU3RhY2sgfSBmcm9tICcuL2FwaS1zdGFjayc7XG5cbi8qKlxuICogQWJzb2x1dGUgcGF0aCB0byB0aGUgaW5nZXN0IExhbWJkYSBoYW5kbGVyIGVudHJ5IHBvaW50LiBUaGUgaGFuZGxlciBpcyBhbiBFU01cbiAqIFR5cGVTY3JpcHQgbW9kdWxlIGluIHRoZSBzaWJsaW5nIGBpbmdlc3QvYCBwYWNrYWdlOyBlc2J1aWxkIGJ1bmRsZXMgaXQgYXRcbiAqIHN5bnRoIHRpbWUuIFJlc29sdmVzIGNvcnJlY3RseSB1bmRlciBib3RoIGB0cy1ub2RlYCAoQ0RLIHN5bnRoKSBhbmQgYHRzY2BcbiAqIChjb21waWxlZCBgbGliL2ApIGJlY2F1c2UgYF9fZGlybmFtZWAgcG9pbnRzIGF0IGBpbmZyYS9saWJgLlxuICovXG5jb25zdCBIQU5ETEVSX0VOVFJZID0gcGF0aC5qb2luKFxuICBfX2Rpcm5hbWUsXG4gICcuLicsXG4gICcuLicsXG4gICdpbmdlc3QnLFxuICAnc3JjJyxcbiAgJ2hhbmRsZXIudHMnLFxuKTtcblxuLyoqXG4gKiBUaGUgaW5nZXN0IHBhY2thZ2UgZGlyZWN0b3J5IChzaWJsaW5nIG9mIGBpbmZyYS9gKSwgdXNlZCBhcyB0aGUgYnVuZGxpbmdcbiAqIHByb2plY3Qgcm9vdC4gVGhlIGhhbmRsZXIgbGl2ZXMgT1VUU0lERSB0aGUgYGluZnJhL2AgcGFja2FnZSwgc28gYGluZnJhL2Anc1xuICogbG9ja2ZpbGUg4oCUIHdoaWNoIGBOb2RlanNGdW5jdGlvbmAgd291bGQgb3RoZXJ3aXNlIGF1dG8tZGV0ZWN0IOKAlCBtYWtlcyB0aGVcbiAqIGVudHJ5IGFwcGVhciBvdXRzaWRlIHRoZSBwcm9qZWN0IHJvb3QuIFJvb3RpbmcgdGhlIGJ1bmRsZSBhdCB0aGUgaW5nZXN0XG4gKiBwYWNrYWdlIGl0c2VsZiBrZWVwcyBgZW50cnlgIHVuZGVyIHRoZSByb290IEFORCBydW5zIGVzYnVpbGQgaW4gYSBkaXJlY3RvcnlcbiAqIHdoZXJlIGl0IGlzIGluc3RhbGxlZCAoYGluZ2VzdC9ub2RlX21vZHVsZXNgKSwgc28gdGhlIGxvY2FsIGJ1bmRsZXIgcmVzb2x2ZXNcbiAqIGBucHggLS1uby1pbnN0YWxsIGVzYnVpbGRgIHdpdGhvdXQgRG9ja2VyLlxuICovXG5jb25zdCBJTkdFU1RfUFJPSkVDVF9ST09UID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJy4uJywgJ2luZ2VzdCcpO1xuXG4vKiogVGhlIGluZ2VzdCBwYWNrYWdlJ3MgbG9ja2ZpbGUsIHVzZWQgYXMgdGhlIGJ1bmRsaW5nIGRlcHMgbG9jayBmaWxlLiAqL1xuY29uc3QgSU5HRVNUX0RFUFNfTE9DS19GSUxFID0gcGF0aC5qb2luKFxuICBJTkdFU1RfUFJPSkVDVF9ST09ULFxuICAncGFja2FnZS1sb2NrLmpzb24nLFxuKTtcblxuLyoqIE1heGltdW0gRXZlbnRCcmlkZ2UgZGVsaXZlcnkgYXR0ZW1wdHMgYmVmb3JlIHJvdXRpbmcgdG8gdGhlIERMUSAoUmVxIDExLjMpLiAqL1xuY29uc3QgTUFYX0VWRU5UX1JFVFJZX0FUVEVNUFRTID0gMztcblxuZXhwb3J0IGludGVyZmFjZSBJbmdlc3RTdGFja1Byb3BzIGV4dGVuZHMgU3RhY2tQcm9wcyB7XG4gIC8qKiBUaGUgZGF0YSBsYXllciB0aGUgaW5nZXN0IExhbWJkYSB3cml0ZXMgdG8uICovXG4gIHJlYWRvbmx5IGRhdGFTdGFjazogRGF0YVN0YWNrO1xuICAvKiogVGhlIEFQSSB0aGUgaW5nZXN0IExhbWJkYSBwdWJsaXNoZXMgdXBkYXRlcyB0aHJvdWdoLiAqL1xuICByZWFkb25seSBhcGlTdGFjazogQXBpU3RhY2s7XG59XG5cbi8qKlxuICogSW5nZXN0U3RhY2sg4oCUIHRoZSBldmVudC1pbmdlc3QgbGF5ZXIuXG4gKlxuICogT3ducyB0aGUgaW5nZXN0IExhbWJkYSAoTm9kZWpzRnVuY3Rpb24gLyBlc2J1aWxkKSwgdGhlIEV2ZW50QnJpZGdlIHJ1bGUgb25cbiAqIHRoZSBkZWZhdWx0IGJ1cyAoc291cmNlID0gYXdzLm9taWNzKSwgdGhlIFNRUyBkZWFkLWxldHRlciBxdWV1ZSBhbmQgcmV0cnlcbiAqIHBvbGljeSwgYW5kIChpbiB0YXNrIDEwLjIpIGxlYXN0LXByaXZpbGVnZSBJQU0uXG4gKlxuICogRXZlbnQgc291cmNlIChkZXNpZ24ubWQgXCJJbmZyYXN0cnVjdHVyZSBhbmQgSUFNIOKGkiBFdmVudEJyaWRnZSwgRExRLCByZXRyeVwiKTpcbiAqICAgQSBydWxlIG9uIHRoZSBERUZBVUxUIGV2ZW50IGJ1cyB3aXRoIHBhdHRlcm4gYHtcInNvdXJjZVwiOiBbXCJhd3Mub21pY3NcIl19YFxuICogICAoUmVxIDEuMSkgdGFyZ2V0cyB0aGUgaW5nZXN0IExhbWJkYSB3aXRoIGEgcmV0cnkgcG9saWN5IG9mIGF0IG1vc3QgM1xuICogICBhdHRlbXB0cyAoUmVxIDExLjMpLCByb3V0aW5nIGRlbGl2ZXJpZXMgdGhhdCBzdGlsbCBmYWlsIHRvIHRoZSBTUVMgRExRXG4gKiAgIChSZXEgMS43KS5cbiAqXG4gKiBUaGUgaW5nZXN0IExhbWJkYSBpcyBhIE5vZGVqc0Z1bmN0aW9uOiBlc2J1aWxkIGJ1bmRsZXMgdGhlIEVTTSBUeXBlU2NyaXB0XG4gKiBoYW5kbGVyIGZvciB0aGUgTm9kZS5qcyAyMC54IHJ1bnRpbWUuIFRoZSBBV1MgU0RLIHYzIGNsaWVudHMgdGhlIGhhbmRsZXIgdXNlc1xuICogYXJlIHByb3ZpZGVkIGJ5IHRoZSBMYW1iZGEgcnVudGltZSwgc28gYEBhd3Mtc2RrLypgIGlzIG1hcmtlZCBleHRlcm5hbCByYXRoZXJcbiAqIHRoYW4gYnVuZGxlZC4gSXRzIHJlbmRlci9wdWJsaXNoIHRhcmdldHMgYXJlIHN1cHBsaWVkIGFzIGVudmlyb25tZW50XG4gKiB2YXJpYWJsZXMgKGBUQUJMRV9OQU1FYCwgYEFQUFNZTkNfRU5EUE9JTlRgKTsgYEFXU19SRUdJT05gIGlzIGluamVjdGVkIGJ5IHRoZVxuICogTGFtYmRhIHJ1bnRpbWUuXG4gKlxuICogVGhlIGluZ2VzdCBmdW5jdGlvbiBhbmQgaXRzIGV4ZWN1dGlvbiByb2xlIGFyZSBleHBvc2VkIGFzIHN0YWNrIHByb3BlcnRpZXMgc29cbiAqIHRhc2sgMTAuMiBjYW4gYXR0YWNoIHRoZSBEeW5hbW9EQiAvIEFwcFN5bmMgLyBIZWFsdGhPbWljcyBsZWFzdC1wcml2aWxlZ2VcbiAqIGdyYW50cyAoUmVxIDIuMywgNC40LCAxMS4yKSDigJQgZGVsaWJlcmF0ZWx5IE5PVCBncmFudGVkIGhlcmUuXG4gKlxuICogUmVxdWlyZW1lbnRzOiAxLjEsIDEuMiwgMS43LCAxMS4zICh0aGlzIHRhc2spOyAyLjMsIDQuNCwgMTEuMiAodGFzayAxMC4yKS5cbiAqL1xuZXhwb3J0IGNsYXNzIEluZ2VzdFN0YWNrIGV4dGVuZHMgU3RhY2sge1xuICAvKiogVGhlIGluZ2VzdCBMYW1iZGEgZnVuY3Rpb247IHRhc2sgMTAuMiBhdHRhY2hlcyBsZWFzdC1wcml2aWxlZ2UgSUFNIHRvIGl0LiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgaW5nZXN0RnVuY3Rpb246IE5vZGVqc0Z1bmN0aW9uO1xuXG4gIC8qKiBUaGUgaW5nZXN0IExhbWJkYSBleGVjdXRpb24gcm9sZSwgZXhwb3NlZCBmb3IgbGVhc3QtcHJpdmlsZWdlIGdyYW50cyAodGFzayAxMC4yKS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGluZ2VzdFJvbGU6IElSb2xlO1xuXG4gIC8qKiBUaGUgU1FTIGRlYWQtbGV0dGVyIHF1ZXVlIGNhcHR1cmluZyBkZWxpdmVyaWVzIHRoYXQgZmFpbCBhZnRlciByZXRyaWVzIChSZXEgMS43KS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGRlYWRMZXR0ZXJRdWV1ZTogUXVldWU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEluZ2VzdFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFNRUyBkZWFkLWxldHRlciBxdWV1ZSBmb3IgRXZlbnRCcmlkZ2UgZGVsaXZlcmllcyB0aGF0IHN0aWxsIGZhaWwgYWZ0ZXIgdGhlXG4gICAgLy8gY29uZmlndXJlZCByZXRyeSBhdHRlbXB0cyAoUmVxIDEuNykuXG4gICAgdGhpcy5kZWFkTGV0dGVyUXVldWUgPSBuZXcgUXVldWUodGhpcywgJ0luZ2VzdERscScsIHtcbiAgICAgIHJldGVudGlvblBlcmlvZDogRHVyYXRpb24uZGF5cygxNCksXG4gICAgfSk7XG5cbiAgICAvLyBUaGUgaW5nZXN0IExhbWJkYTogZXNidWlsZC1idW5kbGVkIEVTTSBUeXBlU2NyaXB0IG9uIE5vZGUuanMgMjAueC5cbiAgICAvL1xuICAgIC8vIElNUE9SVEFOVDogd2UgYnVuZGxlIG91ciBwaW5uZWQgYEBhd3Mtc2RrLypgIGNsaWVudHMgaW50byB0aGUgYXJ0aWZhY3RcbiAgICAvLyByYXRoZXIgdGhhbiByZWx5aW5nIG9uIHRoZSBTREsgYmFrZWQgaW50byB0aGUgTm9kZSAyMCBydW50aW1lLiBUaGUgcnVudGltZVxuICAgIC8vIFNESyBpcyBmcm96ZW4gYXQgYW4gb2xkZXIgdmVyc2lvbiB0aGF0IGRvZXMgbm90IGRlc2VyaWFsaXplIG5ld2VyIEdldFJ1blxuICAgIC8vIHJlc3BvbnNlIGZpZWxkcyAoZS5nLiBuZXR3b3JraW5nTW9kZSAvIGNvbmZpZ3VyYXRpb24gLyB2cGNDb25maWcpLCB3aGljaFxuICAgIC8vIHNpbGVudGx5IGRyb3BwZWQgdGhvc2UgZmllbGRzIGR1cmluZyBlbnJpY2htZW50LiBCdW5kbGluZyB0aGUgcGlubmVkXG4gICAgLy8gY2xpZW50ICgzLjExMTkuMCspIGVuc3VyZXMgdGhlIHJlc3BvbnNlIGlzIHBhcnNlZCB3aXRoIGEgY3VycmVudCBtb2RlbC5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdJbmdlc3RGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogSEFORExFUl9FTlRSWSxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIC8vIFRoZSBoYW5kbGVyIGxpdmVzIGluIHRoZSBzaWJsaW5nIGBpbmdlc3QvYCBwYWNrYWdlLCBvdXRzaWRlIGBpbmZyYS9gLlxuICAgICAgLy8gUm9vdCB0aGUgYnVuZGxlIGF0IHRoZSBpbmdlc3QgcGFja2FnZSBzbyB0aGUgZW50cnkgaXMgdW5kZXIgdGhlIHJvb3RcbiAgICAgIC8vIGFuZCBlc2J1aWxkIHJlc29sdmVzIGZyb20gYGluZ2VzdC9ub2RlX21vZHVsZXNgLlxuICAgICAgcHJvamVjdFJvb3Q6IElOR0VTVF9QUk9KRUNUX1JPT1QsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBJTkdFU1RfREVQU19MT0NLX0ZJTEUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDYwKSxcbiAgICAgIC8vIENhcCBjb25jdXJyZW5jeSBzbyB0aGUgRkxFRVQgb2YgaW5nZXN0IGluc3RhbmNlcyBjYW5ub3QgY29sbGVjdGl2ZWx5XG4gICAgICAvLyBleGNlZWQgdGhlIEhlYWx0aE9taWNzIH4xMCBUUFMgcmVhZCBidWRnZXQ6IGVhY2ggaW5zdGFuY2UgcGFjZXMgaXRzIG93blxuICAgICAgLy8gZW5yaWNobWVudCBjYWxscyB0byBPTUlDU19UUFMgKGJlbG93KSwgYW5kIHJlc2VydmVkQ29uY3VycmVuY3kgw5dcbiAgICAgIC8vIE9NSUNTX1RQUyDiiYggdGhlIGFjY291bnQgYnVkZ2V0LiBUaGlzIGlzIHRoZSBiYXRjaC1zY2FsZSBzYWZlZ3VhcmQg4oCUIGFcbiAgICAgIC8vIGJ1cnN0IG9mIHNldmVyYWwtdGhvdXNhbmQtcnVuIGV2ZW50cyBxdWV1ZXMgaW4gRXZlbnRCcmlkZ2UgYW5kIGlzXG4gICAgICAvLyBkcmFpbmVkIGF0IGEgc2FmZSByYXRlIHJhdGhlciB0aGFuIHNlbGYtaW5mbGljdGluZyBhIHRocm90dGxpbmcgc3Rvcm0uXG4gICAgICAvLyAoNSBpbnN0YW5jZXMgw5cgMiBUUFMgPSB+MTAgVFBTLilcbiAgICAgIHJlc2VydmVkQ29uY3VycmVudEV4ZWN1dGlvbnM6IDUsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAvLyBEeW5hbW9EQiBzaW5nbGUgdGFibGUgdGhlIGhhbmRsZXIgdXBzZXJ0cyBydW4vdGFzay9ncmFwaCBpdGVtcyBpbnRvLlxuICAgICAgICBUQUJMRV9OQU1FOiBwcm9wcy5kYXRhU3RhY2sudGFibGUudGFibGVOYW1lLFxuICAgICAgICAvLyBBcHBTeW5jIEdyYXBoUUwgZW5kcG9pbnQgdGhlIGhhbmRsZXIgcHVibGlzaGVzIHVwZGF0ZXMgdG8uIEFXU19SRUdJT05cbiAgICAgICAgLy8gaXMgcHJvdmlkZWQgYXV0b21hdGljYWxseSBieSB0aGUgTGFtYmRhIHJ1bnRpbWUgYW5kIGlzIHJlYWQgZGlyZWN0bHlcbiAgICAgICAgLy8gYnkgdGhlIGhhbmRsZXIgKGRvIG5vdCBzZXQgaXQgaGVyZSDigJQgaXQgaXMgYSByZXNlcnZlZCBlbnYgdmFyKS5cbiAgICAgICAgQVBQU1lOQ19FTkRQT0lOVDogcHJvcHMuYXBpU3RhY2suYXBpLmdyYXBocWxVcmwsXG4gICAgICAgIC8vIFBlci1pbnN0YW5jZSBIZWFsdGhPbWljcyByZWFkLUFQSSBwYWNlICh0cmFuc2FjdGlvbnMvc2VjKS4gV2l0aFxuICAgICAgICAvLyByZXNlcnZlZENvbmN1cnJlbnRFeGVjdXRpb25zIGFib3ZlLCB0aGUgZmxlZXQgc3RheXMgd2l0aGluIHRoZSB+MTAgVFBTXG4gICAgICAgIC8vIGFjY291bnQgYnVkZ2V0LlxuICAgICAgICBPTUlDU19UUFM6ICcyJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIC8vIEJ1bmRsZSB0aGUgQVdTIFNESyB2MyBjbGllbnRzIChkbyBOT1QgbWFyayB0aGVtIGV4dGVybmFsKSBzbyB0aGVcbiAgICAgICAgLy8gaGFuZGxlciB1c2VzIG91ciBwaW5uZWQsIGN1cnJlbnQgU0RLIHZlcnNpb25zIGluc3RlYWQgb2YgdGhlIG9sZGVyXG4gICAgICAgIC8vIFNESyBiYWtlZCBpbnRvIHRoZSBOb2RlIDIwIHJ1bnRpbWUg4oCUIHRoZSBzdGFsZSBydW50aW1lIFNESyBkcm9wcGVkXG4gICAgICAgIC8vIG5ld2VyIEdldFJ1biByZXNwb25zZSBmaWVsZHMgKG5ldHdvcmtpbmdNb2RlL2NvbmZpZ3VyYXRpb24vdnBjQ29uZmlnKS5cbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbXSxcbiAgICAgICAgLy8gVGhlIEFXUyBTREsgdjMgaW50ZXJuYWxseSB1c2VzIENvbW1vbkpTIGByZXF1aXJlKC4uLilgIChlLmcuXG4gICAgICAgIC8vIGBub2RlOmh0dHBzYCB2aWEgQHNtaXRoeSkuIEJ1bmRsaW5nIGl0IGludG8gYW4gRVNNIG91dHB1dCBtYWtlcyB0aG9zZVxuICAgICAgICAvLyBkeW5hbWljIHJlcXVpcmVzIGZhaWwgYXQgcnVudGltZSAoXCJEeW5hbWljIHJlcXVpcmUgb2YgLi4uIGlzIG5vdFxuICAgICAgICAvLyBzdXBwb3J0ZWRcIikuIEluamVjdCBhIGNyZWF0ZVJlcXVpcmUgc2hpbSBzbyB0aGUgYnVuZGxlZCBDSlMgbW9kdWxlc1xuICAgICAgICAvLyBjYW4gcmVzb2x2ZSB0aGVpciByZXF1aXJlcyB1bmRlciBFU00uXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBFeHBvc2UgdGhlIGF1dG8tY3JlYXRlZCBleGVjdXRpb24gcm9sZSBzbyB0YXNrIDEwLjIgY2FuIGF0dGFjaCB0aGVcbiAgICAvLyBEeW5hbW9EQiAvIEFwcFN5bmMgLyBIZWFsdGhPbWljcyBsZWFzdC1wcml2aWxlZ2UgZ3JhbnRzLlxuICAgIHRoaXMuaW5nZXN0Um9sZSA9IHRoaXMuaW5nZXN0RnVuY3Rpb24ucm9sZSE7XG5cbiAgICAvLyBFdmVudEJyaWRnZSBydWxlIG9uIHRoZSBERUZBVUxUIGJ1cyBtYXRjaGluZyBIZWFsdGhPbWljcyBzdGF0ZS1jaGFuZ2VcbiAgICAvLyBldmVudHMgKFJlcSAxLjEpLiBPbWl0dGluZyBgZXZlbnRCdXNgIHRhcmdldHMgdGhlIGFjY291bnQncyBkZWZhdWx0IGJ1cyxcbiAgICAvLyB3aGljaCBpcyB3aGVyZSBIZWFsdGhPbWljcyBwdWJsaXNoZXMuXG4gICAgY29uc3QgcnVsZSA9IG5ldyBSdWxlKHRoaXMsICdPbWljc0V2ZW50UnVsZScsIHtcbiAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAnUm91dGVzIEFXUyBIZWFsdGhPbWljcyBzdGF0ZS1jaGFuZ2UgZXZlbnRzIChzb3VyY2UgPSBhd3Mub21pY3MpIHRvIHRoZSBpbmdlc3QgTGFtYmRhLicsXG4gICAgICBldmVudFBhdHRlcm46IHtcbiAgICAgICAgc291cmNlOiBbJ2F3cy5vbWljcyddLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFRhcmdldCB0aGUgaW5nZXN0IExhbWJkYSB3aXRoIGEgcmV0cnkgcG9saWN5IG9mIGF0IG1vc3QgMyBhdHRlbXB0c1xuICAgIC8vIChSZXEgMTEuMyk7IGRlbGl2ZXJpZXMgdGhhdCBzdGlsbCBmYWlsIGFyZSByb3V0ZWQgdG8gdGhlIERMUSAoUmVxIDEuNykuXG4gICAgcnVsZS5hZGRUYXJnZXQoXG4gICAgICBuZXcgTGFtYmRhRnVuY3Rpb24odGhpcy5pbmdlc3RGdW5jdGlvbiwge1xuICAgICAgICByZXRyeUF0dGVtcHRzOiBNQVhfRVZFTlRfUkVUUllfQVRURU1QVFMsXG4gICAgICAgIGRlYWRMZXR0ZXJRdWV1ZTogdGhpcy5kZWFkTGV0dGVyUXVldWUsXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gLS0tIExlYXN0LXByaXZpbGVnZSBJQU0gZm9yIHRoZSBpbmdlc3Qgcm9sZSAoUmVxIDIuMywgNC40LCAxMS4yKSAtLS1cbiAgICAvLyBFdmVyeSBzdGF0ZW1lbnQgYmVsb3cgaXMgc2NvcGVkIHRvIGV4cGxpY2l0IGFjdGlvbiBsaXN0cyBhbmQgZXhwbGljaXRcbiAgICAvLyByZXNvdXJjZSBBUk5zLiBUaGVyZSBpcyBOTyBgQWN0aW9uOiBcIipcImAgYW5kIE5PIGBSZXNvdXJjZTogXCIqXCJgIGFueXdoZXJlXG4gICAgLy8gKFJlcSAxMS4yKS5cblxuICAgIC8vIER5bmFtb0RCOiB0aGUgaGFuZGxlciB1cHNlcnRzIHJ1bi90YXNrL2dyYXBoIGl0ZW1zIChQdXRJdGVtL1VwZGF0ZUl0ZW1cbiAgICAvLyB3aXRoIGEgbW9ub3RvbmljIGB1cGRhdGVkQXRgIGNvbmRpdGlvbmFsIGd1YXJkKSwgcmVhZHMgYSBjYWNoZWQgc3RhdGljXG4gICAgLy8gZ3JhcGggKEdldEl0ZW0pLCBhbmQgbWF5IFF1ZXJ5LiBTY29wZSB0byB0aGUgdGFibGUgYW5kIGl0cyBHU0kxIEFSTnMgb25seVxuICAgIC8vIChkZXNpZ24ubWQgXCJEeW5hbW9EQiB3cml0ZSBzY29wZWQgdG8gdGhlIHRhYmxlL0dTSSBBUk5zXCIpLiBDb25kaXRpb25DaGVja0l0ZW1cbiAgICAvLyBjb3ZlcnMgdGhlIHN0YWxlLXdyaXRlIGNvbmRpdGlvbmFsIGd1YXJkLlxuICAgIHRoaXMuaW5nZXN0RnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2R5bmFtb2RiOlB1dEl0ZW0nLFxuICAgICAgICAgICdkeW5hbW9kYjpVcGRhdGVJdGVtJyxcbiAgICAgICAgICAnZHluYW1vZGI6R2V0SXRlbScsXG4gICAgICAgICAgJ2R5bmFtb2RiOlF1ZXJ5JyxcbiAgICAgICAgICAnZHluYW1vZGI6Q29uZGl0aW9uQ2hlY2tJdGVtJyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbcHJvcHMuZGF0YVN0YWNrLnRhYmxlQXJuLCBwcm9wcy5kYXRhU3RhY2suZ3NpMUFybl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gQXBwU3luYzogdGhlIGhhbmRsZXIgaW52b2tlcyB0aGUgSUFNLWF1dGhvcml6ZWQgcHVibGlzaCBtdXRhdGlvbnMgb25seS5cbiAgICAvLyBTY29wZSBgYXBwc3luYzpHcmFwaFFMYCB0byB0aGUgdHdvIHB1Ymxpc2ggZmllbGQgQVJOcyDigJQgbm90IHRoZSB3aG9sZSBBUElcbiAgICAvLyAoUmVxIDQuNCkuIEZpZWxkIEFSTnMgYXJlIGRlcml2ZWQgZnJvbSB0aGUgQVBJJ3MgQVJOICh3aGljaCBlbmNvZGVzIHRoZVxuICAgIC8vIEFQSSBpZCkgd2l0aCB0aGUgR3JhcGhRTCBmaWVsZCBwYXRoIGFwcGVuZGVkLlxuICAgIGNvbnN0IHB1Ymxpc2hGaWVsZEFybnMgPSBbXG4gICAgICAncHVibGlzaFJ1blVwZGF0ZScsXG4gICAgICAncHVibGlzaFRhc2tVcGRhdGUnLFxuICAgIF0ubWFwKChmaWVsZCkgPT4gYCR7cHJvcHMuYXBpU3RhY2suYXBpLmFybn0vdHlwZXMvTXV0YXRpb24vZmllbGRzLyR7ZmllbGR9YCk7XG5cbiAgICB0aGlzLmluZ2VzdEZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydhcHBzeW5jOkdyYXBoUUwnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBwdWJsaXNoRmllbGRBcm5zLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIEhlYWx0aE9taWNzOiBldmVudC10cmlnZ2VyZWQgcmVhZCBlbnJpY2htZW50IG9ubHkg4oCUIEdldFJ1biwgTGlzdFJ1blRhc2tzLFxuICAgIC8vIEdldFJ1blRhc2ssIEdldFdvcmtmbG93LiBObyBjcmVhdGUvdXBkYXRlL2RlbGV0ZSBhY3Rpb25zIChSZXEgMi4zKS4gU2NvcGVcbiAgICAvLyB0byB0aGlzIGFjY291bnQvcmVnaW9uJ3MgcnVuIGFuZCB3b3JrZmxvdyByZXNvdXJjZXMgcmF0aGVyIHRoYW4gYSB3aWxkY2FyZFxuICAgIC8vIHJlc291cmNlIChSZXEgMTEuMikuXG4gICAgdGhpcy5pbmdlc3RGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAnb21pY3M6R2V0UnVuJyxcbiAgICAgICAgICAnb21pY3M6TGlzdFJ1blRhc2tzJyxcbiAgICAgICAgICAnb21pY3M6R2V0UnVuVGFzaycsXG4gICAgICAgICAgJ29taWNzOkdldFdvcmtmbG93JyxcbiAgICAgICAgXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgICAgU3RhY2sub2YodGhpcykuZm9ybWF0QXJuKHtcbiAgICAgICAgICAgIHNlcnZpY2U6ICdvbWljcycsXG4gICAgICAgICAgICByZXNvdXJjZTogJ3J1bicsXG4gICAgICAgICAgICByZXNvdXJjZU5hbWU6ICcqJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBTdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oe1xuICAgICAgICAgICAgc2VydmljZTogJ29taWNzJyxcbiAgICAgICAgICAgIHJlc291cmNlOiAnd29ya2Zsb3cnLFxuICAgICAgICAgICAgcmVzb3VyY2VOYW1lOiAnKicsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gU3RhY2sgb3V0cHV0cyBzbyB0aGUgRExRIGFuZCBmdW5jdGlvbiBhcmUgZGlzY292ZXJhYmxlL29wZXJhYmxlIChSZXEgMTEuNykuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnSW5nZXN0RnVuY3Rpb25OYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuaW5nZXN0RnVuY3Rpb24uZnVuY3Rpb25OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdOYW1lIG9mIHRoZSBpbmdlc3QgTGFtYmRhIGZ1bmN0aW9uLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tSW5nZXN0RnVuY3Rpb25OYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0RlYWRMZXR0ZXJRdWV1ZVVybCcsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmRlYWRMZXR0ZXJRdWV1ZS5xdWV1ZVVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnVVJMIG9mIHRoZSBpbmdlc3QgZGVhZC1sZXR0ZXIgcXVldWUuJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1EZWFkTGV0dGVyUXVldWVVcmxgLFxuICAgIH0pO1xuICB9XG59XG4iXX0=