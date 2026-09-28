import * as path from 'path';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import {
  AuthorizationType,
  Code,
  Definition,
  DynamoDbDataSource,
  FunctionRuntime,
  GraphqlApi,
  Resolver,
} from 'aws-cdk-lib/aws-appsync';
import {
  AccountRecovery,
  UserPool,
  UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';

/** The ingest package dir (sibling of infra/), where the logs handler lives. */
const INGEST_PROJECT_ROOT = path.join(__dirname, '..', '..', 'ingest');
const LOGS_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'logsHandler.ts');
const METRICS_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'metricsHandler.ts');
const COST_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'costHandler.ts');
const REPORTS_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'reportsHandler.ts');
const INGEST_DEPS_LOCK_FILE = path.join(INGEST_PROJECT_ROOT, 'package-lock.json');

/** HealthOmics writes all run logs to this CloudWatch log group. */
const OMICS_LOG_GROUP = '/aws/omics/WorkflowLog';

export interface ApiStackProps extends StackProps {
  /** The data layer this API reads from. Establishes deploy ordering. */
  readonly dataStack: DataStack;
}

/** Absolute path to the GraphQL schema (resolves under both ts-node and tsc). */
const SCHEMA_PATH = path.join(__dirname, '..', 'graphql', 'schema.graphql');

/** Absolute path to the APPSYNC_JS resolver assets directory. */
const RESOLVERS_DIR = path.join(__dirname, '..', 'resolvers');

/** Absolute path to a single named resolver asset. */
function resolverPath(name: string): string {
  return path.join(RESOLVERS_DIR, name);
}

/**
 * ApiStack — the API layer.
 *
 * Owns the AppSync GraphQL API (schema, JS resolvers on DynamoDB, optional
 * Lambda data source), the Cognito user pool + app client, and authorization
 * (default Cognito user pool, IAM for the ingest publish mutations).
 *
 * The Cognito user pool and app client are created BEFORE the API so
 * authorization can never be wired before the pool exists (Req 11.10). The API
 * default authorization mode is the Cognito user pool (Req 5.12, 11.6) with IAM
 * as an additional mode so the ingest Lambda can invoke the IAM-authorized
 * publish mutations (Req 4.3, 4.4).
 *
 * APPSYNC_JS (JS runtime) resolvers back the read queries directly on a
 * DynamoDB data source (Req 5.11): listRuns (GSI1 descending, server-side limit
 * validation, nextToken pagination — Req 5.2–5.5), getRun (GetItem, null when
 * absent — Req 5.6, 5.7), and listTasksForRun (Query by run — Req 5.8). The
 * publish mutations are pass-through resolvers on a NONE data source that echo
 * their input so @aws_subscribe fans out to onRunUpdated / onTaskUpdated
 * (Req 4.5, 4.6).
 *
 * The DynamoDB data source is provisioned READ-ONLY (`readOnlyAccess: true`)
 * so its service role can only read the table/GSI for the query resolvers and
 * never write — deliberately narrower than CDK's default
 * `addDynamoDbDataSource`, which grants read+write. The grant carries no
 * `Action: "*"` and no `Resource: "*"` (Req 11.2).
 *
 * The AppSync endpoint URL, Cognito user pool ID, app client ID, and region are
 * emitted as stack outputs (with export names) so the frontend build can inject
 * them at build time (Req 11.7, task 12.1).
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12,
 * 5.13, 4.5, 4.6, 11.2, 11.6, 11.7, 11.10.
 */
export class ApiStack extends Stack {
  /** The AppSync GraphQL API. */
  public readonly api: GraphqlApi;

  /** The Cognito user pool guarding interactive access to the API. */
  public readonly userPool: UserPool;

  /** The Cognito app client the SPA authenticates against. */
  public readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // Provision the Cognito user pool + app client FIRST, before the API's
    // authorization is configured, so the pool always exists before it is
    // referenced (Req 11.10).
    this.userPool = new UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
    });

    this.userPoolClient = this.userPool.addClient('SpaClient', {
      authFlows: { userSrp: true },
    });

    // AppSync GraphQL API. Default authorization is the Cognito user pool so
    // interactive queries and subscriptions require a valid pool-issued token
    // (Req 5.12, 11.6); requests without valid credentials are rejected without
    // returning data (Req 5.13). IAM is added as an additional authorization
    // mode so only the ingest Lambda's role can call the IAM-authorized publish
    // mutations (Req 4.3, 4.4). The schema exposes the subscriptions and
    // non-nullable stored attributes (Req 5.1, 5.9, 5.10).
    this.api = new GraphqlApi(this, 'GraphqlApi', {
      name: 'HealthOmicsWorkflowDashboard',
      definition: Definition.fromFile(SCHEMA_PATH),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: AuthorizationType.USER_POOL,
          userPoolConfig: { userPool: this.userPool },
        },
        additionalAuthorizationModes: [
          { authorizationType: AuthorizationType.IAM },
        ],
      },
    });

    // DynamoDB data source backed by the single table from the data layer. The
    // read queries resolve directly against it with APPSYNC_JS resolvers
    // (Req 5.11).
    //
    // The data source assumes a dedicated AppSync service role scoped to
    // READ-ONLY DynamoDB access. `readOnlyAccess: true` makes CDK grant only
    // read data actions on the table and its indexes and NEVER any write action
    // (the default `addDynamoDbDataSource` would grant read+write). The read
    // grant carries no `Action: "*"` and no `Resource: "*"` — it is confined to
    // the table's own ARN and index ARNs (Req 11.2). The query resolvers only
    // ever GetItem (getRun) or Query (listRuns via GSI1, listTasksForRun via
    // the table), all of which fall within this read-only grant.
    const dynamoDataSource = new DynamoDbDataSource(this, 'DynamoDataSource', {
      api: this.api,
      table: props.dataStack.table,
      readOnlyAccess: true,
    });

    this.addReadResolvers(dynamoDataSource);
    this.addPublishResolvers();
    this.addLogsResolver();
    this.addMetricsResolver();
    this.addCostResolver(props.dataStack.table);
    this.addReportsResolver(props.dataStack.table, props.dataStack.gsi2Name);

    this.addOutputs();
  }

  /**
   * Lambda-backed resolver for the `getRunLogs` and `getErrorExcerpt` queries.
   *
   * APPSYNC_JS resolvers cannot call CloudWatch Logs, so both queries are
   * backed by a single small NodejsFunction (ingest/src/logsHandler.ts, entry
   * point `router`) exposed as one AppSync Lambda data source — a direct
   * Lambda resolver with no request/response mapping template, so AppSync
   * passes the entire resolver context (including `info.fieldName`) and the
   * function dispatches on it (confirmed against the AWS AppSync
   * direct-Lambda-resolver reference). `getErrorExcerpt` (Option B: extract
   * the actual error from the log stream rather than relying on HealthOmics'
   * often-generic `statusMessage`) reuses the same CloudWatch Logs IAM grant
   * as `getRunLogs` — no new permissions needed, since it reads the identical
   * log group/streams. The Lambda is granted READ-ONLY access to the
   * HealthOmics run log group only (no wildcards, Req 11.2), and both queries
   * are Cognito-authorized like the other reads.
   */
  private addLogsResolver(): void {
    const logsFn = new NodejsFunction(this, 'LogsFunction', {
      runtime: Runtime.NODEJS_20_X,
      entry: LOGS_HANDLER_ENTRY,
      handler: 'router',
      projectRoot: INGEST_PROJECT_ROOT,
      depsLockFilePath: INGEST_DEPS_LOCK_FILE,
      timeout: Duration.seconds(30),
      environment: {
        LOG_GROUP_NAME: OMICS_LOG_GROUP,
      },
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
        // The @smithy HTTP handler (bundled via `NodeHttpHandler`, used to set
        // the CloudWatch Logs client's connect/request timeouts) internally uses
        // CommonJS `require(...)` (e.g. `node:https`). Bundling that CJS into an
        // ESM output makes those dynamic requires fail at runtime ("Dynamic
        // require of \"node:https\" is not supported"), which crashes the
        // function at INIT and surfaces in the UI as "Logs could not be loaded".
        // Inject a createRequire shim so the bundled CJS modules can resolve
        // their requires under ESM (same fix the ingest Lambda uses).
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
      },
    });

    // Least-privilege: read-only access to the HealthOmics run log group and
    // its streams only. No wildcard action, no wildcard resource (Req 11.2).
    // CloudWatch log-group ARNs use a COLON separator before the (leading-slash)
    // group name: arn:aws:logs:<region>:<acct>:log-group:/aws/omics/WorkflowLog.
    // Build it explicitly to avoid formatArn inserting a slash separator (which
    // would yield an invalid `log-group//aws/...`). The `:*` variant covers the
    // group's log streams.
    const { region, account } = Stack.of(this);
    const logGroupArn = `arn:aws:logs:${region}:${account}:log-group:${OMICS_LOG_GROUP}`;
    logsFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'logs:GetLogEvents',
          'logs:FilterLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [logGroupArn, `${logGroupArn}:*`],
      }),
    );

    const logsDataSource = this.api.addLambdaDataSource(
      'LogsDataSource',
      logsFn,
    );

    // Default request/response mapping passes the entire resolver context
    // through to the Lambda (direct Lambda resolver) and returns its result
    // as-is. One resolver per field, both on the same Lambda data source; the
    // Lambda's `router` entry point dispatches on `info.fieldName`.
    logsDataSource.createResolver('getRunLogsResolver', {
      typeName: 'Query',
      fieldName: 'getRunLogs',
    });
    logsDataSource.createResolver('getErrorExcerptResolver', {
      typeName: 'Query',
      fieldName: 'getErrorExcerpt',
    });
  }

  /**
   * Lambda-backed resolver for the `getRunMetrics` query.
   *
   * There is no AWS SDK operation for CloudWatch's Prometheus-compatible
   * PromQL API, so `getRunMetrics` is backed by a NodejsFunction
   * (ingest/src/metricsHandler.ts) that builds and SigV4-signs a raw HTTPS
   * POST itself, exposed as an AppSync Lambda data source (mirrors
   * `addLogsResolver`). The query is Cognito-authorized like the other reads.
   *
   * Least-privilege IAM, VERIFIED-REQUIRED (empirically confirmed via a live
   * scoped-role test + AWS docs — see design.md IAM section): the CloudWatch
   * PromQL `QueryMetrics` operation requires BOTH `cloudwatch:GetMetricData`
   * AND `cloudwatch:ListMetrics`. `Resource: '*'` is used for these two
   * actions because they do not support resource-level ARN scoping —
   * confirmed by the 403 message returned during verification, which named a
   * dataset ARN CloudWatch controls internally, not a customer-scopable
   * resource. This is a documented exception to the no-wildcard-resource
   * pattern used elsewhere in this stack, but it is NOT a wildcard action
   * (no `Action: '*'`).
   *
   * A separate, narrow `omics:GetRun` grant scoped to run ARNs backs the
   * window-resolution fallback (design "Run window" decision): it is used
   * only when the caller omits `startTime`/`endTime`.
   */
  private addMetricsResolver(): void {
    const metricsFn = new NodejsFunction(this, 'MetricsFunction', {
      runtime: Runtime.NODEJS_20_X,
      entry: METRICS_HANDLER_ENTRY,
      handler: 'handler',
      projectRoot: INGEST_PROJECT_ROOT,
      depsLockFilePath: INGEST_DEPS_LOCK_FILE,
      timeout: Duration.seconds(30),
      environment: {
        METRICS_REGION: Stack.of(this).region,
        MONITORING_HOST: `monitoring.${Stack.of(this).region}.amazonaws.com`,
        SIGNING_SERVICE: 'monitoring',
      },
      bundling: {
        format: OutputFormat.ESM,
        // Externalize only the AWS SDK modules present in the Lambda runtime.
        // @smithy/signature-v4 and @aws-crypto/sha256-js are NOT in the
        // runtime, so they are bundled (NOT externalized) — this is the key
        // difference from addLogsResolver's bundling.
        externalModules: ['@aws-sdk/*'],
        // @smithy/signature-v4 and @aws-crypto/sha256-js are authored as
        // CommonJS and internally use `require(...)` (e.g. for Node built-ins
        // like "buffer"). Bundling CJS into an ESM output leaves no `require`
        // in scope, so those dynamic requires crash at runtime with "Dynamic
        // require of ... is not supported" (confirmed via CloudWatch Logs).
        // Inject the same createRequire shim used by IngestStack's bundling so
        // the bundled CJS modules can resolve their requires under ESM.
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
      },
    });

    // Least-privilege IAM, VERIFIED-REQUIRED (empirically confirmed via a
    // live scoped-role test + AWS docs — see design.md IAM section): the
    // CloudWatch PromQL QueryMetrics operation requires BOTH actions below.
    // Resource '*' because these CloudWatch metric-data actions do not
    // support resource-level ARN scoping (confirmed by the 403 message
    // during verification, which named a dataset ARN CloudWatch controls
    // internally, not a customer-scopable resource). No Action: '*'.
    metricsFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
        resources: ['*'],
      }),
    );

    // Narrow, run-ARN-scoped fallback permission for the window-resolution
    // GetRun call (design "Run window" decision) — only used when the
    // caller omits startTime/endTime.
    const { region, account } = Stack.of(this);
    metricsFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['omics:GetRun'],
        resources: [`arn:aws:omics:${region}:${account}:run/*`],
      }),
    );

    const metricsDataSource = this.api.addLambdaDataSource(
      'MetricsDataSource',
      metricsFn,
    );

    metricsDataSource.createResolver('getRunMetricsResolver', {
      typeName: 'Query',
      fieldName: 'getRunMetrics',
    });
  }

  /**
   * Lambda-backed resolver for the `getRunCostEstimate` query.
   *
   * Mirrors `addMetricsResolver()`: a NodejsFunction
   * (ingest/src/costHandler.ts) exposed as an AppSync Lambda data source,
   * Cognito-authorized like the other reads. It bundles the same
   * `@smithy/signature-v4`/`@aws-crypto/sha256-js` CJS-in-ESM deps (for the
   * DYNAMIC-storage RUN_FILESYSTEM PromQL query), so it carries the identical
   * ESM `createRequire` banner shim.
   *
   * Least-privilege IAM:
   * - `pricing:GetProducts`/`pricing:DescribeServices` on Resource '*' — the
   *   Price List API does NOT support resource-level scoping, a DOCUMENTED
   *   exception to the no-wildcard-resource pattern (like the CloudWatch
   *   metrics grant). NOT a wildcard action.
   * - `cloudwatch:GetMetricData`/`cloudwatch:ListMetrics` on Resource '*' — the
   *   same CloudWatch PromQL grant as the metrics Lambda (no resource-level
   *   scoping). NOT a wildcard action.
   * - `omics:GetRun` scoped to run ARNs for the run window/storage fields.
   * - a DynamoDB grant scoped to the single-table ARN, limited to
   *   GetItem/PutItem/UpdateItem for the rate-card cache item.
   *
   * No statement carries `Action: '*'`.
   */
  private addCostResolver(table: DataStack['table']): void {
    const costFn = new NodejsFunction(this, 'CostFunction', {
      runtime: Runtime.NODEJS_20_X,
      entry: COST_HANDLER_ENTRY,
      handler: 'handler',
      projectRoot: INGEST_PROJECT_ROOT,
      depsLockFilePath: INGEST_DEPS_LOCK_FILE,
      timeout: Duration.seconds(30),
      environment: {
        COST_REGION: Stack.of(this).region,
        COST_TABLE_NAME: table.tableName,
        MONITORING_HOST: `monitoring.${Stack.of(this).region}.amazonaws.com`,
        SIGNING_SERVICE: 'monitoring',
      },
      bundling: {
        format: OutputFormat.ESM,
        // signature-v4/sha256 bundled (not externalized), like the metrics
        // Lambda — @aws-sdk/* stays external as it is in the Node runtime.
        externalModules: ['@aws-sdk/*'],
        // Inject the createRequire shim so the bundled CJS deps can resolve
        // their dynamic requires under ESM (see addMetricsResolver).
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
      },
    });

    // Price List: read-only actions. Resource '*' because the Price List API
    // does NOT support resource-level scoping — an intentional, DOCUMENTED
    // exception to the no-wildcard-resource pattern, exactly like the existing
    // CloudWatch metrics grant. NOT a wildcard action (Req 7.1, 7.2, 7.3).
    costFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['pricing:GetProducts', 'pricing:DescribeServices'],
        resources: ['*'],
      }),
    );

    // CloudWatch PromQL (DYNAMIC-storage RUN_FILESYSTEM GB-hours), same grant
    // as the metrics Lambda; Resource '*' (no resource-level scoping), NOT a
    // wildcard action.
    costFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
        resources: ['*'],
      }),
    );

    // omics:GetRun for the run window/storage fields, scoped to run ARNs (no
    // wildcard action).
    const { region, account } = Stack.of(this);
    costFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['omics:GetRun'],
        resources: [`arn:aws:omics:${region}:${account}:run/*`],
      }),
    );

    // DynamoDB access, scoped to the single table ARN (least privilege, like
    // the existing grants):
    //   - Query: list the run's task items (PK = RUN#<runId>, SK begins_with
    //     TASK#) in the cost handler's loadRunTasks.
    //   - GetItem/PutItem/UpdateItem: the region rate-card cache item.
    table.grant(
      costFn,
      'dynamodb:Query',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    );

    const costDataSource = this.api.addLambdaDataSource(
      'CostDataSource',
      costFn,
    );

    costDataSource.createResolver('getRunCostEstimateResolver', {
      typeName: 'Query',
      fieldName: 'getRunCostEstimate',
    });
  }

  /**
   * Lambda-backed resolver for the `listWorkflowGroups` and `getWorkflowReport`
   * queries (workflow-performance-reports). One NodejsFunction backs both
   * fields, dispatched on `info.fieldName` (direct-Lambda-resolver router, like
   * `addLogsResolver`). Both queries are Cognito-authorized like the other
   * reads.
   *
   * Least-privilege IAM: the Lambda only reads the single table — a `Query` on
   * GSI2 (per-group windowed report) and a `Scan` (the group picker). No
   * CloudWatch/pricing/omics grants are needed because the Run_Summary rollups
   * are pre-computed at ingest time; the report is a pure read-and-aggregate.
   */
  private addReportsResolver(
    table: DataStack['table'],
    gsi2Name: string,
  ): void {
    const reportsFn = new NodejsFunction(this, 'ReportsFunction', {
      runtime: Runtime.NODEJS_20_X,
      entry: REPORTS_HANDLER_ENTRY,
      handler: 'handler',
      projectRoot: INGEST_PROJECT_ROOT,
      depsLockFilePath: INGEST_DEPS_LOCK_FILE,
      timeout: Duration.seconds(30),
      environment: {
        REPORTS_REGION: Stack.of(this).region,
        REPORTS_TABLE_NAME: table.tableName,
        REPORTS_GSI2_NAME: gsi2Name,
      },
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
        banner:
          "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
      },
    });

    // Read-only DynamoDB access scoped to the table (and its indexes, which
    // `grant` covers via the table ARN + `/index/*`). Query backs the per-group
    // GSI2 report; Scan backs the group picker. No write actions.
    table.grant(reportsFn, 'dynamodb:Query', 'dynamodb:Scan');

    const reportsDataSource = this.api.addLambdaDataSource(
      'ReportsDataSource',
      reportsFn,
    );

    reportsDataSource.createResolver('listWorkflowGroupsResolver', {
      typeName: 'Query',
      fieldName: 'listWorkflowGroups',
    });
    reportsDataSource.createResolver('getWorkflowReportResolver', {
      typeName: 'Query',
      fieldName: 'getWorkflowReport',
    });
    reportsDataSource.createResolver('listWorkflowRunPointsResolver', {
      typeName: 'Query',
      fieldName: 'listWorkflowRunPoints',
    });
  }

  /**
   * Stack outputs consumed by the frontend build (task 12.1).
   *
   * The AppSync GraphQL endpoint URL, Cognito user pool ID, app client ID, and
   * region are emitted with export names so the Vite build can inject them at
   * build time and the SPA carries no hardcoded environment values (Req 11.7).
   */
  private addOutputs(): void {
    const outputs: ReadonlyArray<{
      id: string;
      value: string;
      description: string;
    }> = [
      {
        id: 'GraphqlApiUrl',
        value: this.api.graphqlUrl,
        description: 'AppSync GraphQL endpoint URL.',
      },
      {
        id: 'UserPoolId',
        value: this.userPool.userPoolId,
        description: 'Cognito user pool ID.',
      },
      {
        id: 'UserPoolClientId',
        value: this.userPoolClient.userPoolClientId,
        description: 'Cognito app client ID for the SPA.',
      },
      {
        id: 'Region',
        value: this.region,
        description: 'AWS region the API is deployed in.',
      },
    ];

    for (const { id, value, description } of outputs) {
      new CfnOutput(this, id, {
        value,
        description,
        exportName: `${this.stackName}-${id}`,
      });
    }
  }

  /**
   * APPSYNC_JS read resolvers on the DynamoDB data source.
   *
   * - listRuns: Query GSI1 (GSI1PK = 'RUNS') descending by updatedAt with
   *   server-side limit validation (1–100, default 25) and nextToken
   *   pagination; out-of-range limits and malformed/expired tokens are rejected
   *   (Req 5.2, 5.3, 5.4, 5.5).
   * - getRun: GetItem PK = SK = 'RUN#<runId>'; null (no error) when absent
   *   (Req 5.6, 5.7).
   * - listTasksForRun: Query PK = 'RUN#<runId>', SK begins_with 'TASK#';
   *   returns items or an empty list (Req 5.8).
   * - getStaticGraph: GetItem PK = SK = 'WF#<workflowId>#<workflowVersionName>';
   *   null (no error) when absent or a failure-only marker (Req 6.6). GetItem
   *   only, within the existing read-only grant — no new data source/IAM.
   */
  private addReadResolvers(dataSource: DynamoDbDataSource): void {
    const reads: ReadonlyArray<{ field: string; file: string }> = [
      { field: 'listRuns', file: 'listRuns.js' },
      { field: 'getRun', file: 'getRun.js' },
      { field: 'listTasksForRun', file: 'listTasksForRun.js' },
      { field: 'getStaticGraph', file: 'getStaticGraph.js' },
    ];

    for (const { field, file } of reads) {
      new Resolver(this, `${field}Resolver`, {
        api: this.api,
        typeName: 'Query',
        fieldName: field,
        dataSource,
        runtime: FunctionRuntime.JS_1_0_0,
        code: Code.fromAsset(resolverPath(file)),
      });
    }
  }

  /**
   * Pass-through resolvers for the IAM-authorized publish mutations.
   *
   * publishRunUpdate / publishTaskUpdate carry no data-source work: they echo
   * their input on a NONE (local) data source so @aws_subscribe fans the
   * payload out to onRunUpdated / onTaskUpdated subscribers (Req 4.5, 4.6). The
   * ingest Lambda has already persisted the run/task before calling them.
   */
  private addPublishResolvers(): void {
    const noneDataSource = this.api.addNoneDataSource('PublishNoneDataSource');

    for (const field of ['publishRunUpdate', 'publishTaskUpdate']) {
      new Resolver(this, `${field}Resolver`, {
        api: this.api,
        typeName: 'Mutation',
        fieldName: field,
        dataSource: noneDataSource,
        runtime: FunctionRuntime.JS_1_0_0,
        code: Code.fromAsset(resolverPath('publishPassthrough.js')),
      });
    }
  }
}
