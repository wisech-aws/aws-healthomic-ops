import * as path from 'path';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Effect, IRole, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';
import { ApiStack } from './api-stack';

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

    // EventBridge rule on the DEFAULT bus matching HealthOmics state-change
    // events (Req 1.1). Omitting `eventBus` targets the account's default bus,
    // which is where HealthOmics publishes.
    const rule = new Rule(this, 'OmicsEventRule', {
      description:
        'Routes AWS HealthOmics state-change events (source = aws.omics) to the ingest Lambda.',
      eventPattern: {
        source: ['aws.omics'],
      },
    });

    // Target the ingest Lambda with a retry policy of at most 3 attempts
    // (Req 11.3); deliveries that still fail are routed to the DLQ (Req 1.7).
    rule.addTarget(
      new LambdaFunction(this.ingestFunction, {
        retryAttempts: MAX_EVENT_RETRY_ATTEMPTS,
        deadLetterQueue: this.deadLetterQueue,
      }),
    );

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
}
