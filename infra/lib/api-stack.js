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
exports.ApiStack = void 0;
const path = __importStar(require("path"));
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_appsync_1 = require("aws-cdk-lib/aws-appsync");
const aws_cognito_1 = require("aws-cdk-lib/aws-cognito");
const aws_lambda_1 = require("aws-cdk-lib/aws-lambda");
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const aws_iam_1 = require("aws-cdk-lib/aws-iam");
/** The ingest package dir (sibling of infra/), where the logs handler lives. */
const INGEST_PROJECT_ROOT = path.join(__dirname, '..', '..', 'ingest');
const LOGS_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'logsHandler.ts');
const METRICS_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'metricsHandler.ts');
const COST_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'costHandler.ts');
const REPORTS_HANDLER_ENTRY = path.join(INGEST_PROJECT_ROOT, 'src', 'reportsHandler.ts');
const INGEST_DEPS_LOCK_FILE = path.join(INGEST_PROJECT_ROOT, 'package-lock.json');
/** HealthOmics writes all run logs to this CloudWatch log group. */
const OMICS_LOG_GROUP = '/aws/omics/WorkflowLog';
/** Absolute path to the GraphQL schema (resolves under both ts-node and tsc). */
const SCHEMA_PATH = path.join(__dirname, '..', 'graphql', 'schema.graphql');
/** Absolute path to the APPSYNC_JS resolver assets directory. */
const RESOLVERS_DIR = path.join(__dirname, '..', 'resolvers');
/** Absolute path to a single named resolver asset. */
function resolverPath(name) {
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
class ApiStack extends aws_cdk_lib_1.Stack {
    /** The AppSync GraphQL API. */
    api;
    /** The Cognito user pool guarding interactive access to the API. */
    userPool;
    /** The Cognito app client the SPA authenticates against. */
    userPoolClient;
    constructor(scope, id, props) {
        super(scope, id, props);
        // Provision the Cognito user pool + app client FIRST, before the API's
        // authorization is configured, so the pool always exists before it is
        // referenced (Req 11.10).
        this.userPool = new aws_cognito_1.UserPool(this, 'UserPool', {
            selfSignUpEnabled: false,
            signInAliases: { email: true },
            standardAttributes: {
                email: { required: true, mutable: true },
            },
            accountRecovery: aws_cognito_1.AccountRecovery.EMAIL_ONLY,
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
        this.api = new aws_appsync_1.GraphqlApi(this, 'GraphqlApi', {
            name: 'HealthOmicsWorkflowDashboard',
            definition: aws_appsync_1.Definition.fromFile(SCHEMA_PATH),
            authorizationConfig: {
                defaultAuthorization: {
                    authorizationType: aws_appsync_1.AuthorizationType.USER_POOL,
                    userPoolConfig: { userPool: this.userPool },
                },
                additionalAuthorizationModes: [
                    { authorizationType: aws_appsync_1.AuthorizationType.IAM },
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
        const dynamoDataSource = new aws_appsync_1.DynamoDbDataSource(this, 'DynamoDataSource', {
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
    addLogsResolver() {
        const logsFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'LogsFunction', {
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            entry: LOGS_HANDLER_ENTRY,
            handler: 'router',
            projectRoot: INGEST_PROJECT_ROOT,
            depsLockFilePath: INGEST_DEPS_LOCK_FILE,
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            environment: {
                LOG_GROUP_NAME: OMICS_LOG_GROUP,
            },
            bundling: {
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
                externalModules: ['@aws-sdk/*'],
                // The @smithy HTTP handler (bundled via `NodeHttpHandler`, used to set
                // the CloudWatch Logs client's connect/request timeouts) internally uses
                // CommonJS `require(...)` (e.g. `node:https`). Bundling that CJS into an
                // ESM output makes those dynamic requires fail at runtime ("Dynamic
                // require of \"node:https\" is not supported"), which crashes the
                // function at INIT and surfaces in the UI as "Logs could not be loaded".
                // Inject a createRequire shim so the bundled CJS modules can resolve
                // their requires under ESM (same fix the ingest Lambda uses).
                banner: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
            },
        });
        // Least-privilege: read-only access to the HealthOmics run log group and
        // its streams only. No wildcard action, no wildcard resource (Req 11.2).
        // CloudWatch log-group ARNs use a COLON separator before the (leading-slash)
        // group name: arn:aws:logs:<region>:<acct>:log-group:/aws/omics/WorkflowLog.
        // Build it explicitly to avoid formatArn inserting a slash separator (which
        // would yield an invalid `log-group//aws/...`). The `:*` variant covers the
        // group's log streams.
        const { region, account } = aws_cdk_lib_1.Stack.of(this);
        const logGroupArn = `arn:aws:logs:${region}:${account}:log-group:${OMICS_LOG_GROUP}`;
        logsFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: [
                'logs:GetLogEvents',
                'logs:FilterLogEvents',
                'logs:DescribeLogStreams',
            ],
            resources: [logGroupArn, `${logGroupArn}:*`],
        }));
        const logsDataSource = this.api.addLambdaDataSource('LogsDataSource', logsFn);
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
    addMetricsResolver() {
        const metricsFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'MetricsFunction', {
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            entry: METRICS_HANDLER_ENTRY,
            handler: 'handler',
            projectRoot: INGEST_PROJECT_ROOT,
            depsLockFilePath: INGEST_DEPS_LOCK_FILE,
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            environment: {
                METRICS_REGION: aws_cdk_lib_1.Stack.of(this).region,
                MONITORING_HOST: `monitoring.${aws_cdk_lib_1.Stack.of(this).region}.amazonaws.com`,
                SIGNING_SERVICE: 'monitoring',
            },
            bundling: {
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
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
                banner: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
            },
        });
        // Least-privilege IAM, VERIFIED-REQUIRED (empirically confirmed via a
        // live scoped-role test + AWS docs — see design.md IAM section): the
        // CloudWatch PromQL QueryMetrics operation requires BOTH actions below.
        // Resource '*' because these CloudWatch metric-data actions do not
        // support resource-level ARN scoping (confirmed by the 403 message
        // during verification, which named a dataset ARN CloudWatch controls
        // internally, not a customer-scopable resource). No Action: '*'.
        metricsFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
            resources: ['*'],
        }));
        // Narrow, run-ARN-scoped fallback permission for the window-resolution
        // GetRun call (design "Run window" decision) — only used when the
        // caller omits startTime/endTime.
        const { region, account } = aws_cdk_lib_1.Stack.of(this);
        metricsFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['omics:GetRun'],
            resources: [`arn:aws:omics:${region}:${account}:run/*`],
        }));
        const metricsDataSource = this.api.addLambdaDataSource('MetricsDataSource', metricsFn);
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
    addCostResolver(table) {
        const costFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'CostFunction', {
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            entry: COST_HANDLER_ENTRY,
            handler: 'handler',
            projectRoot: INGEST_PROJECT_ROOT,
            depsLockFilePath: INGEST_DEPS_LOCK_FILE,
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            environment: {
                COST_REGION: aws_cdk_lib_1.Stack.of(this).region,
                COST_TABLE_NAME: table.tableName,
                MONITORING_HOST: `monitoring.${aws_cdk_lib_1.Stack.of(this).region}.amazonaws.com`,
                SIGNING_SERVICE: 'monitoring',
            },
            bundling: {
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
                // signature-v4/sha256 bundled (not externalized), like the metrics
                // Lambda — @aws-sdk/* stays external as it is in the Node runtime.
                externalModules: ['@aws-sdk/*'],
                // Inject the createRequire shim so the bundled CJS deps can resolve
                // their dynamic requires under ESM (see addMetricsResolver).
                banner: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
            },
        });
        // Price List: read-only actions. Resource '*' because the Price List API
        // does NOT support resource-level scoping — an intentional, DOCUMENTED
        // exception to the no-wildcard-resource pattern, exactly like the existing
        // CloudWatch metrics grant. NOT a wildcard action (Req 7.1, 7.2, 7.3).
        costFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['pricing:GetProducts', 'pricing:DescribeServices'],
            resources: ['*'],
        }));
        // CloudWatch PromQL (DYNAMIC-storage RUN_FILESYSTEM GB-hours), same grant
        // as the metrics Lambda; Resource '*' (no resource-level scoping), NOT a
        // wildcard action.
        costFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'],
            resources: ['*'],
        }));
        // omics:GetRun for the run window/storage fields, scoped to run ARNs (no
        // wildcard action).
        const { region, account } = aws_cdk_lib_1.Stack.of(this);
        costFn.addToRolePolicy(new aws_iam_1.PolicyStatement({
            effect: aws_iam_1.Effect.ALLOW,
            actions: ['omics:GetRun'],
            resources: [`arn:aws:omics:${region}:${account}:run/*`],
        }));
        // DynamoDB access, scoped to the single table ARN (least privilege, like
        // the existing grants):
        //   - Query: list the run's task items (PK = RUN#<runId>, SK begins_with
        //     TASK#) in the cost handler's loadRunTasks.
        //   - GetItem/PutItem/UpdateItem: the region rate-card cache item.
        table.grant(costFn, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
        const costDataSource = this.api.addLambdaDataSource('CostDataSource', costFn);
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
    addReportsResolver(table, gsi2Name) {
        const reportsFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'ReportsFunction', {
            runtime: aws_lambda_1.Runtime.NODEJS_20_X,
            entry: REPORTS_HANDLER_ENTRY,
            handler: 'handler',
            projectRoot: INGEST_PROJECT_ROOT,
            depsLockFilePath: INGEST_DEPS_LOCK_FILE,
            timeout: aws_cdk_lib_1.Duration.seconds(30),
            environment: {
                REPORTS_REGION: aws_cdk_lib_1.Stack.of(this).region,
                REPORTS_TABLE_NAME: table.tableName,
                REPORTS_GSI2_NAME: gsi2Name,
            },
            bundling: {
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
                externalModules: ['@aws-sdk/*'],
                banner: "import{createRequire as __createRequire}from'module';const require=__createRequire(import.meta.url);",
            },
        });
        // Read-only DynamoDB access scoped to the table (and its indexes, which
        // `grant` covers via the table ARN + `/index/*`). Query backs the per-group
        // GSI2 report; Scan backs the group picker. No write actions.
        table.grant(reportsFn, 'dynamodb:Query', 'dynamodb:Scan');
        const reportsDataSource = this.api.addLambdaDataSource('ReportsDataSource', reportsFn);
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
    addOutputs() {
        const outputs = [
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
            new aws_cdk_lib_1.CfnOutput(this, id, {
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
    addReadResolvers(dataSource) {
        const reads = [
            { field: 'listRuns', file: 'listRuns.js' },
            { field: 'getRun', file: 'getRun.js' },
            { field: 'listTasksForRun', file: 'listTasksForRun.js' },
            { field: 'getStaticGraph', file: 'getStaticGraph.js' },
        ];
        for (const { field, file } of reads) {
            new aws_appsync_1.Resolver(this, `${field}Resolver`, {
                api: this.api,
                typeName: 'Query',
                fieldName: field,
                dataSource,
                runtime: aws_appsync_1.FunctionRuntime.JS_1_0_0,
                code: aws_appsync_1.Code.fromAsset(resolverPath(file)),
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
    addPublishResolvers() {
        const noneDataSource = this.api.addNoneDataSource('PublishNoneDataSource');
        for (const field of ['publishRunUpdate', 'publishTaskUpdate']) {
            new aws_appsync_1.Resolver(this, `${field}Resolver`, {
                api: this.api,
                typeName: 'Mutation',
                fieldName: field,
                dataSource: noneDataSource,
                runtime: aws_appsync_1.FunctionRuntime.JS_1_0_0,
                code: aws_appsync_1.Code.fromAsset(resolverPath('publishPassthrough.js')),
            });
        }
    }
}
exports.ApiStack = ApiStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBpLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDJDQUE2QjtBQUM3Qiw2Q0FBcUU7QUFDckUseURBUWlDO0FBQ2pDLHlEQUlpQztBQUNqQyx1REFBaUQ7QUFDakQscUVBQTZFO0FBQzdFLGlEQUE4RDtBQUk5RCxnRkFBZ0Y7QUFDaEYsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ3ZFLE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUNuRixNQUFNLHFCQUFxQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxFQUFFLG1CQUFtQixDQUFDLENBQUM7QUFDekYsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixFQUFFLEtBQUssRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0FBQ25GLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLEVBQUUsbUJBQW1CLENBQUMsQ0FBQztBQUN6RixNQUFNLHFCQUFxQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEVBQUUsbUJBQW1CLENBQUMsQ0FBQztBQUVsRixvRUFBb0U7QUFDcEUsTUFBTSxlQUFlLEdBQUcsd0JBQXdCLENBQUM7QUFPakQsaUZBQWlGO0FBQ2pGLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUU1RSxpRUFBaUU7QUFDakUsTUFBTSxh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QUFFLElBQUksQ0FBQyxHQUFHO2dCQUNiLFFBQVEsRUFBRSxVQUFVO2dCQUNwQixTQUFTLEVBQUUsS0FBSztnQkFDaEIsVUFBVSxFQUFFLGNBQWM7Z0JBQzFCLE9BQU8sRUFBRSw2QkFBZSxDQUFDLFFBQVE7Z0JBQ2pDLElBQUksRUFBRSxrQkFBSSxDQUFDLFNBQVMsQ0FBQyxZQUFZLENBQUMsdUJBQXVCLENBQUMsQ0FBQzthQUM1RCxDQUFDLENBQUM7UUFDTCxDQUFDO0lBQ0gsQ0FBQztDQUNGO0FBN2dCRCw0QkE2Z0JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCB7IENmbk91dHB1dCwgRHVyYXRpb24sIFN0YWNrLCBTdGFja1Byb3BzIH0gZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHtcbiAgQXV0aG9yaXphdGlvblR5cGUsXG4gIENvZGUsXG4gIERlZmluaXRpb24sXG4gIER5bmFtb0RiRGF0YVNvdXJjZSxcbiAgRnVuY3Rpb25SdW50aW1lLFxuICBHcmFwaHFsQXBpLFxuICBSZXNvbHZlcixcbn0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwcHN5bmMnO1xuaW1wb3J0IHtcbiAgQWNjb3VudFJlY292ZXJ5LFxuICBVc2VyUG9vbCxcbiAgVXNlclBvb2xDbGllbnQsXG59IGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCB7IFJ1bnRpbWUgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uLCBPdXRwdXRGb3JtYXQgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgeyBFZmZlY3QsIFBvbGljeVN0YXRlbWVudCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBEYXRhU3RhY2sgfSBmcm9tICcuL2RhdGEtc3RhY2snO1xuXG4vKiogVGhlIGluZ2VzdCBwYWNrYWdlIGRpciAoc2libGluZyBvZiBpbmZyYS8pLCB3aGVyZSB0aGUgbG9ncyBoYW5kbGVyIGxpdmVzLiAqL1xuY29uc3QgSU5HRVNUX1BST0pFQ1RfUk9PVCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICcuLicsICdpbmdlc3QnKTtcbmNvbnN0IExPR1NfSEFORExFUl9FTlRSWSA9IHBhdGguam9pbihJTkdFU1RfUFJPSkVDVF9ST09ULCAnc3JjJywgJ2xvZ3NIYW5kbGVyLnRzJyk7XG5jb25zdCBNRVRSSUNTX0hBTkRMRVJfRU5UUlkgPSBwYXRoLmpvaW4oSU5HRVNUX1BST0pFQ1RfUk9PVCwgJ3NyYycsICdtZXRyaWNzSGFuZGxlci50cycpO1xuY29uc3QgQ09TVF9IQU5ETEVSX0VOVFJZID0gcGF0aC5qb2luKElOR0VTVF9QUk9KRUNUX1JPT1QsICdzcmMnLCAnY29zdEhhbmRsZXIudHMnKTtcbmNvbnN0IFJFUE9SVFNfSEFORExFUl9FTlRSWSA9IHBhdGguam9pbihJTkdFU1RfUFJPSkVDVF9ST09ULCAnc3JjJywgJ3JlcG9ydHNIYW5kbGVyLnRzJyk7XG5jb25zdCBJTkdFU1RfREVQU19MT0NLX0ZJTEUgPSBwYXRoLmpvaW4oSU5HRVNUX1BST0pFQ1RfUk9PVCwgJ3BhY2thZ2UtbG9jay5qc29uJyk7XG5cbi8qKiBIZWFsdGhPbWljcyB3cml0ZXMgYWxsIHJ1biBsb2dzIHRvIHRoaXMgQ2xvdWRXYXRjaCBsb2cgZ3JvdXAuICovXG5jb25zdCBPTUlDU19MT0dfR1JPVVAgPSAnL2F3cy9vbWljcy9Xb3JrZmxvd0xvZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBpU3RhY2tQcm9wcyBleHRlbmRzIFN0YWNrUHJvcHMge1xuICAvKiogVGhlIGRhdGEgbGF5ZXIgdGhpcyBBUEkgcmVhZHMgZnJvbS4gRXN0YWJsaXNoZXMgZGVwbG95IG9yZGVyaW5nLiAqL1xuICByZWFkb25seSBkYXRhU3RhY2s6IERhdGFTdGFjaztcbn1cblxuLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIEdyYXBoUUwgc2NoZW1hIChyZXNvbHZlcyB1bmRlciBib3RoIHRzLW5vZGUgYW5kIHRzYykuICovXG5jb25zdCBTQ0hFTUFfUEFUSCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdncmFwaHFsJywgJ3NjaGVtYS5ncmFwaHFsJyk7XG5cbi8qKiBBYnNvbHV0ZSBwYXRoIHRvIHRoZSBBUFBTWU5DX0pTIHJlc29sdmVyIGFzc2V0cyBkaXJlY3RvcnkuICovXG5jb25zdCBSRVNPTFZFUlNfRElSID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ3Jlc29sdmVycycpO1xuXG4vKiogQWJzb2x1dGUgcGF0aCB0byBhIHNpbmdsZSBuYW1lZCByZXNvbHZlciBhc3NldC4gKi9cbmZ1bmN0aW9uIHJlc29sdmVyUGF0aChuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5qb2luKFJFU09MVkVSU19ESVIsIG5hbWUpO1xufVxuXG4vKipcbiAqIEFwaVN0YWNrIOKAlCB0aGUgQVBJIGxheWVyLlxuICpcbiAqIE93bnMgdGhlIEFwcFN5bmMgR3JhcGhRTCBBUEkgKHNjaGVtYSwgSlMgcmVzb2x2ZXJzIG9uIER5bmFtb0RCLCBvcHRpb25hbFxuICogTGFtYmRhIGRhdGEgc291cmNlKSwgdGhlIENvZ25pdG8gdXNlciBwb29sICsgYXBwIGNsaWVudCwgYW5kIGF1dGhvcml6YXRpb25cbiAqIChkZWZhdWx0IENvZ25pdG8gdXNlciBwb29sLCBJQU0gZm9yIHRoZSBpbmdlc3QgcHVibGlzaCBtdXRhdGlvbnMpLlxuICpcbiAqIFRoZSBDb2duaXRvIHVzZXIgcG9vbCBhbmQgYXBwIGNsaWVudCBhcmUgY3JlYXRlZCBCRUZPUkUgdGhlIEFQSSBzb1xuICogYXV0aG9yaXphdGlvbiBjYW4gbmV2ZXIgYmUgd2lyZWQgYmVmb3JlIHRoZSBwb29sIGV4aXN0cyAoUmVxIDExLjEwKS4gVGhlIEFQSVxuICogZGVmYXVsdCBhdXRob3JpemF0aW9uIG1vZGUgaXMgdGhlIENvZ25pdG8gdXNlciBwb29sIChSZXEgNS4xMiwgMTEuNikgd2l0aCBJQU1cbiAqIGFzIGFuIGFkZGl0aW9uYWwgbW9kZSBzbyB0aGUgaW5nZXN0IExhbWJkYSBjYW4gaW52b2tlIHRoZSBJQU0tYXV0aG9yaXplZFxuICogcHVibGlzaCBtdXRhdGlvbnMgKFJlcSA0LjMsIDQuNCkuXG4gKlxuICogQVBQU1lOQ19KUyAoSlMgcnVudGltZSkgcmVzb2x2ZXJzIGJhY2sgdGhlIHJlYWQgcXVlcmllcyBkaXJlY3RseSBvbiBhXG4gKiBEeW5hbW9EQiBkYXRhIHNvdXJjZSAoUmVxIDUuMTEpOiBsaXN0UnVucyAoR1NJMSBkZXNjZW5kaW5nLCBzZXJ2ZXItc2lkZSBsaW1pdFxuICogdmFsaWRhdGlvbiwgbmV4dFRva2VuIHBhZ2luYXRpb24g4oCUIFJlcSA1LjLigJM1LjUpLCBnZXRSdW4gKEdldEl0ZW0sIG51bGwgd2hlblxuICogYWJzZW50IOKAlCBSZXEgNS42LCA1LjcpLCBhbmQgbGlzdFRhc2tzRm9yUnVuIChRdWVyeSBieSBydW4g4oCUIFJlcSA1LjgpLiBUaGVcbiAqIHB1Ymxpc2ggbXV0YXRpb25zIGFyZSBwYXNzLXRocm91Z2ggcmVzb2x2ZXJzIG9uIGEgTk9ORSBkYXRhIHNvdXJjZSB0aGF0IGVjaG9cbiAqIHRoZWlyIGlucHV0IHNvIEBhd3Nfc3Vic2NyaWJlIGZhbnMgb3V0IHRvIG9uUnVuVXBkYXRlZCAvIG9uVGFza1VwZGF0ZWRcbiAqIChSZXEgNC41LCA0LjYpLlxuICpcbiAqIFRoZSBEeW5hbW9EQiBkYXRhIHNvdXJjZSBpcyBwcm92aXNpb25lZCBSRUFELU9OTFkgKGByZWFkT25seUFjY2VzczogdHJ1ZWApXG4gKiBzbyBpdHMgc2VydmljZSByb2xlIGNhbiBvbmx5IHJlYWQgdGhlIHRhYmxlL0dTSSBmb3IgdGhlIHF1ZXJ5IHJlc29sdmVycyBhbmRcbiAqIG5ldmVyIHdyaXRlIOKAlCBkZWxpYmVyYXRlbHkgbmFycm93ZXIgdGhhbiBDREsncyBkZWZhdWx0XG4gKiBgYWRkRHluYW1vRGJEYXRhU291cmNlYCwgd2hpY2ggZ3JhbnRzIHJlYWQrd3JpdGUuIFRoZSBncmFudCBjYXJyaWVzIG5vXG4gKiBgQWN0aW9uOiBcIipcImAgYW5kIG5vIGBSZXNvdXJjZTogXCIqXCJgIChSZXEgMTEuMikuXG4gKlxuICogVGhlIEFwcFN5bmMgZW5kcG9pbnQgVVJMLCBDb2duaXRvIHVzZXIgcG9vbCBJRCwgYXBwIGNsaWVudCBJRCwgYW5kIHJlZ2lvbiBhcmVcbiAqIGVtaXR0ZWQgYXMgc3RhY2sgb3V0cHV0cyAod2l0aCBleHBvcnQgbmFtZXMpIHNvIHRoZSBmcm9udGVuZCBidWlsZCBjYW4gaW5qZWN0XG4gKiB0aGVtIGF0IGJ1aWxkIHRpbWUgKFJlcSAxMS43LCB0YXNrIDEyLjEpLlxuICpcbiAqIFJlcXVpcmVtZW50czogNS4xLCA1LjIsIDUuMywgNS40LCA1LjUsIDUuNiwgNS43LCA1LjgsIDUuOSwgNS4xMCwgNS4xMSwgNS4xMixcbiAqIDUuMTMsIDQuNSwgNC42LCAxMS4yLCAxMS42LCAxMS43LCAxMS4xMC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwaVN0YWNrIGV4dGVuZHMgU3RhY2sge1xuICAvKiogVGhlIEFwcFN5bmMgR3JhcGhRTCBBUEkuICovXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IEdyYXBocWxBcGk7XG5cbiAgLyoqIFRoZSBDb2duaXRvIHVzZXIgcG9vbCBndWFyZGluZyBpbnRlcmFjdGl2ZSBhY2Nlc3MgdG8gdGhlIEFQSS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sOiBVc2VyUG9vbDtcblxuICAvKiogVGhlIENvZ25pdG8gYXBwIGNsaWVudCB0aGUgU1BBIGF1dGhlbnRpY2F0ZXMgYWdhaW5zdC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sQ2xpZW50OiBVc2VyUG9vbENsaWVudDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBpU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gUHJvdmlzaW9uIHRoZSBDb2duaXRvIHVzZXIgcG9vbCArIGFwcCBjbGllbnQgRklSU1QsIGJlZm9yZSB0aGUgQVBJJ3NcbiAgICAvLyBhdXRob3JpemF0aW9uIGlzIGNvbmZpZ3VyZWQsIHNvIHRoZSBwb29sIGFsd2F5cyBleGlzdHMgYmVmb3JlIGl0IGlzXG4gICAgLy8gcmVmZXJlbmNlZCAoUmVxIDExLjEwKS5cbiAgICB0aGlzLnVzZXJQb29sID0gbmV3IFVzZXJQb29sKHRoaXMsICdVc2VyUG9vbCcsIHtcbiAgICAgIHNlbGZTaWduVXBFbmFibGVkOiBmYWxzZSxcbiAgICAgIHNpZ25JbkFsaWFzZXM6IHsgZW1haWw6IHRydWUgfSxcbiAgICAgIHN0YW5kYXJkQXR0cmlidXRlczoge1xuICAgICAgICBlbWFpbDogeyByZXF1aXJlZDogdHJ1ZSwgbXV0YWJsZTogdHJ1ZSB9LFxuICAgICAgfSxcbiAgICAgIGFjY291bnRSZWNvdmVyeTogQWNjb3VudFJlY292ZXJ5LkVNQUlMX09OTFksXG4gICAgfSk7XG5cbiAgICB0aGlzLnVzZXJQb29sQ2xpZW50ID0gdGhpcy51c2VyUG9vbC5hZGRDbGllbnQoJ1NwYUNsaWVudCcsIHtcbiAgICAgIGF1dGhGbG93czogeyB1c2VyU3JwOiB0cnVlIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBcHBTeW5jIEdyYXBoUUwgQVBJLiBEZWZhdWx0IGF1dGhvcml6YXRpb24gaXMgdGhlIENvZ25pdG8gdXNlciBwb29sIHNvXG4gICAgLy8gaW50ZXJhY3RpdmUgcXVlcmllcyBhbmQgc3Vic2NyaXB0aW9ucyByZXF1aXJlIGEgdmFsaWQgcG9vbC1pc3N1ZWQgdG9rZW5cbiAgICAvLyAoUmVxIDUuMTIsIDExLjYpOyByZXF1ZXN0cyB3aXRob3V0IHZhbGlkIGNyZWRlbnRpYWxzIGFyZSByZWplY3RlZCB3aXRob3V0XG4gICAgLy8gcmV0dXJuaW5nIGRhdGEgKFJlcSA1LjEzKS4gSUFNIGlzIGFkZGVkIGFzIGFuIGFkZGl0aW9uYWwgYXV0aG9yaXphdGlvblxuICAgIC8vIG1vZGUgc28gb25seSB0aGUgaW5nZXN0IExhbWJkYSdzIHJvbGUgY2FuIGNhbGwgdGhlIElBTS1hdXRob3JpemVkIHB1Ymxpc2hcbiAgICAvLyBtdXRhdGlvbnMgKFJlcSA0LjMsIDQuNCkuIFRoZSBzY2hlbWEgZXhwb3NlcyB0aGUgc3Vic2NyaXB0aW9ucyBhbmRcbiAgICAvLyBub24tbnVsbGFibGUgc3RvcmVkIGF0dHJpYnV0ZXMgKFJlcSA1LjEsIDUuOSwgNS4xMCkuXG4gICAgdGhpcy5hcGkgPSBuZXcgR3JhcGhxbEFwaSh0aGlzLCAnR3JhcGhxbEFwaScsIHtcbiAgICAgIG5hbWU6ICdIZWFsdGhPbWljc1dvcmtmbG93RGFzaGJvYXJkJyxcbiAgICAgIGRlZmluaXRpb246IERlZmluaXRpb24uZnJvbUZpbGUoU0NIRU1BX1BBVEgpLFxuICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzoge1xuICAgICAgICBkZWZhdWx0QXV0aG9yaXphdGlvbjoge1xuICAgICAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBBdXRob3JpemF0aW9uVHlwZS5VU0VSX1BPT0wsXG4gICAgICAgICAgdXNlclBvb2xDb25maWc6IHsgdXNlclBvb2w6IHRoaXMudXNlclBvb2wgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbEF1dGhvcml6YXRpb25Nb2RlczogW1xuICAgICAgICAgIHsgYXV0aG9yaXphdGlvblR5cGU6IEF1dGhvcml6YXRpb25UeXBlLklBTSB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIER5bmFtb0RCIGRhdGEgc291cmNlIGJhY2tlZCBieSB0aGUgc2luZ2xlIHRhYmxlIGZyb20gdGhlIGRhdGEgbGF5ZXIuIFRoZVxuICAgIC8vIHJlYWQgcXVlcmllcyByZXNvbHZlIGRpcmVjdGx5IGFnYWluc3QgaXQgd2l0aCBBUFBTWU5DX0pTIHJlc29sdmVyc1xuICAgIC8vIChSZXEgNS4xMSkuXG4gICAgLy9cbiAgICAvLyBUaGUgZGF0YSBzb3VyY2UgYXNzdW1lcyBhIGRlZGljYXRlZCBBcHBTeW5jIHNlcnZpY2Ugcm9sZSBzY29wZWQgdG9cbiAgICAvLyBSRUFELU9OTFkgRHluYW1vREIgYWNjZXNzLiBgcmVhZE9ubHlBY2Nlc3M6IHRydWVgIG1ha2VzIENESyBncmFudCBvbmx5XG4gICAgLy8gcmVhZCBkYXRhIGFjdGlvbnMgb24gdGhlIHRhYmxlIGFuZCBpdHMgaW5kZXhlcyBhbmQgTkVWRVIgYW55IHdyaXRlIGFjdGlvblxuICAgIC8vICh0aGUgZGVmYXVsdCBgYWRkRHluYW1vRGJEYXRhU291cmNlYCB3b3VsZCBncmFudCByZWFkK3dyaXRlKS4gVGhlIHJlYWRcbiAgICAvLyBncmFudCBjYXJyaWVzIG5vIGBBY3Rpb246IFwiKlwiYCBhbmQgbm8gYFJlc291cmNlOiBcIipcImAg4oCUIGl0IGlzIGNvbmZpbmVkIHRvXG4gICAgLy8gdGhlIHRhYmxlJ3Mgb3duIEFSTiBhbmQgaW5kZXggQVJOcyAoUmVxIDExLjIpLiBUaGUgcXVlcnkgcmVzb2x2ZXJzIG9ubHlcbiAgICAvLyBldmVyIEdldEl0ZW0gKGdldFJ1bikgb3IgUXVlcnkgKGxpc3RSdW5zIHZpYSBHU0kxLCBsaXN0VGFza3NGb3JSdW4gdmlhXG4gICAgLy8gdGhlIHRhYmxlKSwgYWxsIG9mIHdoaWNoIGZhbGwgd2l0aGluIHRoaXMgcmVhZC1vbmx5IGdyYW50LlxuICAgIGNvbnN0IGR5bmFtb0RhdGFTb3VyY2UgPSBuZXcgRHluYW1vRGJEYXRhU291cmNlKHRoaXMsICdEeW5hbW9EYXRhU291cmNlJywge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIHRhYmxlOiBwcm9wcy5kYXRhU3RhY2sudGFibGUsXG4gICAgICByZWFkT25seUFjY2VzczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkUmVhZFJlc29sdmVycyhkeW5hbW9EYXRhU291cmNlKTtcbiAgICB0aGlzLmFkZFB1Ymxpc2hSZXNvbHZlcnMoKTtcbiAgICB0aGlzLmFkZExvZ3NSZXNvbHZlcigpO1xuICAgIHRoaXMuYWRkTWV0cmljc1Jlc29sdmVyKCk7XG4gICAgdGhpcy5hZGRDb3N0UmVzb2x2ZXIocHJvcHMuZGF0YVN0YWNrLnRhYmxlKTtcbiAgICB0aGlzLmFkZFJlcG9ydHNSZXNvbHZlcihwcm9wcy5kYXRhU3RhY2sudGFibGUsIHByb3BzLmRhdGFTdGFjay5nc2kyTmFtZSk7XG5cbiAgICB0aGlzLmFkZE91dHB1dHMoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBMYW1iZGEtYmFja2VkIHJlc29sdmVyIGZvciB0aGUgYGdldFJ1bkxvZ3NgIGFuZCBgZ2V0RXJyb3JFeGNlcnB0YCBxdWVyaWVzLlxuICAgKlxuICAgKiBBUFBTWU5DX0pTIHJlc29sdmVycyBjYW5ub3QgY2FsbCBDbG91ZFdhdGNoIExvZ3MsIHNvIGJvdGggcXVlcmllcyBhcmVcbiAgICogYmFja2VkIGJ5IGEgc2luZ2xlIHNtYWxsIE5vZGVqc0Z1bmN0aW9uIChpbmdlc3Qvc3JjL2xvZ3NIYW5kbGVyLnRzLCBlbnRyeVxuICAgKiBwb2ludCBgcm91dGVyYCkgZXhwb3NlZCBhcyBvbmUgQXBwU3luYyBMYW1iZGEgZGF0YSBzb3VyY2Ug4oCUIGEgZGlyZWN0XG4gICAqIExhbWJkYSByZXNvbHZlciB3aXRoIG5vIHJlcXVlc3QvcmVzcG9uc2UgbWFwcGluZyB0ZW1wbGF0ZSwgc28gQXBwU3luY1xuICAgKiBwYXNzZXMgdGhlIGVudGlyZSByZXNvbHZlciBjb250ZXh0IChpbmNsdWRpbmcgYGluZm8uZmllbGROYW1lYCkgYW5kIHRoZVxuICAgKiBmdW5jdGlvbiBkaXNwYXRjaGVzIG9uIGl0IChjb25maXJtZWQgYWdhaW5zdCB0aGUgQVdTIEFwcFN5bmNcbiAgICogZGlyZWN0LUxhbWJkYS1yZXNvbHZlciByZWZlcmVuY2UpLiBgZ2V0RXJyb3JFeGNlcnB0YCAoT3B0aW9uIEI6IGV4dHJhY3RcbiAgICogdGhlIGFjdHVhbCBlcnJvciBmcm9tIHRoZSBsb2cgc3RyZWFtIHJhdGhlciB0aGFuIHJlbHlpbmcgb24gSGVhbHRoT21pY3MnXG4gICAqIG9mdGVuLWdlbmVyaWMgYHN0YXR1c01lc3NhZ2VgKSByZXVzZXMgdGhlIHNhbWUgQ2xvdWRXYXRjaCBMb2dzIElBTSBncmFudFxuICAgKiBhcyBgZ2V0UnVuTG9nc2Ag4oCUIG5vIG5ldyBwZXJtaXNzaW9ucyBuZWVkZWQsIHNpbmNlIGl0IHJlYWRzIHRoZSBpZGVudGljYWxcbiAgICogbG9nIGdyb3VwL3N0cmVhbXMuIFRoZSBMYW1iZGEgaXMgZ3JhbnRlZCBSRUFELU9OTFkgYWNjZXNzIHRvIHRoZVxuICAgKiBIZWFsdGhPbWljcyBydW4gbG9nIGdyb3VwIG9ubHkgKG5vIHdpbGRjYXJkcywgUmVxIDExLjIpLCBhbmQgYm90aCBxdWVyaWVzXG4gICAqIGFyZSBDb2duaXRvLWF1dGhvcml6ZWQgbGlrZSB0aGUgb3RoZXIgcmVhZHMuXG4gICAqL1xuICBwcml2YXRlIGFkZExvZ3NSZXNvbHZlcigpOiB2b2lkIHtcbiAgICBjb25zdCBsb2dzRm4gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0xvZ3NGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogTE9HU19IQU5ETEVSX0VOVFJZLFxuICAgICAgaGFuZGxlcjogJ3JvdXRlcicsXG4gICAgICBwcm9qZWN0Um9vdDogSU5HRVNUX1BST0pFQ1RfUk9PVCxcbiAgICAgIGRlcHNMb2NrRmlsZVBhdGg6IElOR0VTVF9ERVBTX0xPQ0tfRklMRSxcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTE9HX0dST1VQX05BTUU6IE9NSUNTX0xPR19HUk9VUCxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogWydAYXdzLXNkay8qJ10sXG4gICAgICAgIC8vIFRoZSBAc21pdGh5IEhUVFAgaGFuZGxlciAoYnVuZGxlZCB2aWEgYE5vZGVIdHRwSGFuZGxlcmAsIHVzZWQgdG8gc2V0XG4gICAgICAgIC8vIHRoZSBDbG91ZFdhdGNoIExvZ3MgY2xpZW50J3MgY29ubmVjdC9yZXF1ZXN0IHRpbWVvdXRzKSBpbnRlcm5hbGx5IHVzZXNcbiAgICAgICAgLy8gQ29tbW9uSlMgYHJlcXVpcmUoLi4uKWAgKGUuZy4gYG5vZGU6aHR0cHNgKS4gQnVuZGxpbmcgdGhhdCBDSlMgaW50byBhblxuICAgICAgICAvLyBFU00gb3V0cHV0IG1ha2VzIHRob3NlIGR5bmFtaWMgcmVxdWlyZXMgZmFpbCBhdCBydW50aW1lIChcIkR5bmFtaWNcbiAgICAgICAgLy8gcmVxdWlyZSBvZiBcXFwibm9kZTpodHRwc1xcXCIgaXMgbm90IHN1cHBvcnRlZFwiKSwgd2hpY2ggY3Jhc2hlcyB0aGVcbiAgICAgICAgLy8gZnVuY3Rpb24gYXQgSU5JVCBhbmQgc3VyZmFjZXMgaW4gdGhlIFVJIGFzIFwiTG9ncyBjb3VsZCBub3QgYmUgbG9hZGVkXCIuXG4gICAgICAgIC8vIEluamVjdCBhIGNyZWF0ZVJlcXVpcmUgc2hpbSBzbyB0aGUgYnVuZGxlZCBDSlMgbW9kdWxlcyBjYW4gcmVzb2x2ZVxuICAgICAgICAvLyB0aGVpciByZXF1aXJlcyB1bmRlciBFU00gKHNhbWUgZml4IHRoZSBpbmdlc3QgTGFtYmRhIHVzZXMpLlxuICAgICAgICBiYW5uZXI6XG4gICAgICAgICAgXCJpbXBvcnR7Y3JlYXRlUmVxdWlyZSBhcyBfX2NyZWF0ZVJlcXVpcmV9ZnJvbSdtb2R1bGUnO2NvbnN0IHJlcXVpcmU9X19jcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTGVhc3QtcHJpdmlsZWdlOiByZWFkLW9ubHkgYWNjZXNzIHRvIHRoZSBIZWFsdGhPbWljcyBydW4gbG9nIGdyb3VwIGFuZFxuICAgIC8vIGl0cyBzdHJlYW1zIG9ubHkuIE5vIHdpbGRjYXJkIGFjdGlvbiwgbm8gd2lsZGNhcmQgcmVzb3VyY2UgKFJlcSAxMS4yKS5cbiAgICAvLyBDbG91ZFdhdGNoIGxvZy1ncm91cCBBUk5zIHVzZSBhIENPTE9OIHNlcGFyYXRvciBiZWZvcmUgdGhlIChsZWFkaW5nLXNsYXNoKVxuICAgIC8vIGdyb3VwIG5hbWU6IGFybjphd3M6bG9nczo8cmVnaW9uPjo8YWNjdD46bG9nLWdyb3VwOi9hd3Mvb21pY3MvV29ya2Zsb3dMb2cuXG4gICAgLy8gQnVpbGQgaXQgZXhwbGljaXRseSB0byBhdm9pZCBmb3JtYXRBcm4gaW5zZXJ0aW5nIGEgc2xhc2ggc2VwYXJhdG9yICh3aGljaFxuICAgIC8vIHdvdWxkIHlpZWxkIGFuIGludmFsaWQgYGxvZy1ncm91cC8vYXdzLy4uLmApLiBUaGUgYDoqYCB2YXJpYW50IGNvdmVycyB0aGVcbiAgICAvLyBncm91cCdzIGxvZyBzdHJlYW1zLlxuICAgIGNvbnN0IHsgcmVnaW9uLCBhY2NvdW50IH0gPSBTdGFjay5vZih0aGlzKTtcbiAgICBjb25zdCBsb2dHcm91cEFybiA9IGBhcm46YXdzOmxvZ3M6JHtyZWdpb259OiR7YWNjb3VudH06bG9nLWdyb3VwOiR7T01JQ1NfTE9HX0dST1VQfWA7XG4gICAgbG9nc0ZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdsb2dzOkdldExvZ0V2ZW50cycsXG4gICAgICAgICAgJ2xvZ3M6RmlsdGVyTG9nRXZlbnRzJyxcbiAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtsb2dHcm91cEFybiwgYCR7bG9nR3JvdXBBcm59OipgXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBjb25zdCBsb2dzRGF0YVNvdXJjZSA9IHRoaXMuYXBpLmFkZExhbWJkYURhdGFTb3VyY2UoXG4gICAgICAnTG9nc0RhdGFTb3VyY2UnLFxuICAgICAgbG9nc0ZuLFxuICAgICk7XG5cbiAgICAvLyBEZWZhdWx0IHJlcXVlc3QvcmVzcG9uc2UgbWFwcGluZyBwYXNzZXMgdGhlIGVudGlyZSByZXNvbHZlciBjb250ZXh0XG4gICAgLy8gdGhyb3VnaCB0byB0aGUgTGFtYmRhIChkaXJlY3QgTGFtYmRhIHJlc29sdmVyKSBhbmQgcmV0dXJucyBpdHMgcmVzdWx0XG4gICAgLy8gYXMtaXMuIE9uZSByZXNvbHZlciBwZXIgZmllbGQsIGJvdGggb24gdGhlIHNhbWUgTGFtYmRhIGRhdGEgc291cmNlOyB0aGVcbiAgICAvLyBMYW1iZGEncyBgcm91dGVyYCBlbnRyeSBwb2ludCBkaXNwYXRjaGVzIG9uIGBpbmZvLmZpZWxkTmFtZWAuXG4gICAgbG9nc0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2dldFJ1bkxvZ3NSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnZ2V0UnVuTG9ncycsXG4gICAgfSk7XG4gICAgbG9nc0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2dldEVycm9yRXhjZXJwdFJlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdnZXRFcnJvckV4Y2VycHQnLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIExhbWJkYS1iYWNrZWQgcmVzb2x2ZXIgZm9yIHRoZSBgZ2V0UnVuTWV0cmljc2AgcXVlcnkuXG4gICAqXG4gICAqIFRoZXJlIGlzIG5vIEFXUyBTREsgb3BlcmF0aW9uIGZvciBDbG91ZFdhdGNoJ3MgUHJvbWV0aGV1cy1jb21wYXRpYmxlXG4gICAqIFByb21RTCBBUEksIHNvIGBnZXRSdW5NZXRyaWNzYCBpcyBiYWNrZWQgYnkgYSBOb2RlanNGdW5jdGlvblxuICAgKiAoaW5nZXN0L3NyYy9tZXRyaWNzSGFuZGxlci50cykgdGhhdCBidWlsZHMgYW5kIFNpZ1Y0LXNpZ25zIGEgcmF3IEhUVFBTXG4gICAqIFBPU1QgaXRzZWxmLCBleHBvc2VkIGFzIGFuIEFwcFN5bmMgTGFtYmRhIGRhdGEgc291cmNlIChtaXJyb3JzXG4gICAqIGBhZGRMb2dzUmVzb2x2ZXJgKS4gVGhlIHF1ZXJ5IGlzIENvZ25pdG8tYXV0aG9yaXplZCBsaWtlIHRoZSBvdGhlciByZWFkcy5cbiAgICpcbiAgICogTGVhc3QtcHJpdmlsZWdlIElBTSwgVkVSSUZJRUQtUkVRVUlSRUQgKGVtcGlyaWNhbGx5IGNvbmZpcm1lZCB2aWEgYSBsaXZlXG4gICAqIHNjb3BlZC1yb2xlIHRlc3QgKyBBV1MgZG9jcyDigJQgc2VlIGRlc2lnbi5tZCBJQU0gc2VjdGlvbik6IHRoZSBDbG91ZFdhdGNoXG4gICAqIFByb21RTCBgUXVlcnlNZXRyaWNzYCBvcGVyYXRpb24gcmVxdWlyZXMgQk9USCBgY2xvdWR3YXRjaDpHZXRNZXRyaWNEYXRhYFxuICAgKiBBTkQgYGNsb3Vkd2F0Y2g6TGlzdE1ldHJpY3NgLiBgUmVzb3VyY2U6ICcqJ2AgaXMgdXNlZCBmb3IgdGhlc2UgdHdvXG4gICAqIGFjdGlvbnMgYmVjYXVzZSB0aGV5IGRvIG5vdCBzdXBwb3J0IHJlc291cmNlLWxldmVsIEFSTiBzY29waW5nIOKAlFxuICAgKiBjb25maXJtZWQgYnkgdGhlIDQwMyBtZXNzYWdlIHJldHVybmVkIGR1cmluZyB2ZXJpZmljYXRpb24sIHdoaWNoIG5hbWVkIGFcbiAgICogZGF0YXNldCBBUk4gQ2xvdWRXYXRjaCBjb250cm9scyBpbnRlcm5hbGx5LCBub3QgYSBjdXN0b21lci1zY29wYWJsZVxuICAgKiByZXNvdXJjZS4gVGhpcyBpcyBhIGRvY3VtZW50ZWQgZXhjZXB0aW9uIHRvIHRoZSBuby13aWxkY2FyZC1yZXNvdXJjZVxuICAgKiBwYXR0ZXJuIHVzZWQgZWxzZXdoZXJlIGluIHRoaXMgc3RhY2ssIGJ1dCBpdCBpcyBOT1QgYSB3aWxkY2FyZCBhY3Rpb25cbiAgICogKG5vIGBBY3Rpb246ICcqJ2ApLlxuICAgKlxuICAgKiBBIHNlcGFyYXRlLCBuYXJyb3cgYG9taWNzOkdldFJ1bmAgZ3JhbnQgc2NvcGVkIHRvIHJ1biBBUk5zIGJhY2tzIHRoZVxuICAgKiB3aW5kb3ctcmVzb2x1dGlvbiBmYWxsYmFjayAoZGVzaWduIFwiUnVuIHdpbmRvd1wiIGRlY2lzaW9uKTogaXQgaXMgdXNlZFxuICAgKiBvbmx5IHdoZW4gdGhlIGNhbGxlciBvbWl0cyBgc3RhcnRUaW1lYC9gZW5kVGltZWAuXG4gICAqL1xuICBwcml2YXRlIGFkZE1ldHJpY3NSZXNvbHZlcigpOiB2b2lkIHtcbiAgICBjb25zdCBtZXRyaWNzRm4gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ01ldHJpY3NGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogTUVUUklDU19IQU5ETEVSX0VOVFJZLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgcHJvamVjdFJvb3Q6IElOR0VTVF9QUk9KRUNUX1JPT1QsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBJTkdFU1RfREVQU19MT0NLX0ZJTEUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE1FVFJJQ1NfUkVHSU9OOiBTdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICAgIE1PTklUT1JJTkdfSE9TVDogYG1vbml0b3JpbmcuJHtTdGFjay5vZih0aGlzKS5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICAgICAgICBTSUdOSU5HX1NFUlZJQ0U6ICdtb25pdG9yaW5nJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIC8vIEV4dGVybmFsaXplIG9ubHkgdGhlIEFXUyBTREsgbW9kdWxlcyBwcmVzZW50IGluIHRoZSBMYW1iZGEgcnVudGltZS5cbiAgICAgICAgLy8gQHNtaXRoeS9zaWduYXR1cmUtdjQgYW5kIEBhd3MtY3J5cHRvL3NoYTI1Ni1qcyBhcmUgTk9UIGluIHRoZVxuICAgICAgICAvLyBydW50aW1lLCBzbyB0aGV5IGFyZSBidW5kbGVkIChOT1QgZXh0ZXJuYWxpemVkKSDigJQgdGhpcyBpcyB0aGUga2V5XG4gICAgICAgIC8vIGRpZmZlcmVuY2UgZnJvbSBhZGRMb2dzUmVzb2x2ZXIncyBidW5kbGluZy5cbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbJ0Bhd3Mtc2RrLyonXSxcbiAgICAgICAgLy8gQHNtaXRoeS9zaWduYXR1cmUtdjQgYW5kIEBhd3MtY3J5cHRvL3NoYTI1Ni1qcyBhcmUgYXV0aG9yZWQgYXNcbiAgICAgICAgLy8gQ29tbW9uSlMgYW5kIGludGVybmFsbHkgdXNlIGByZXF1aXJlKC4uLilgIChlLmcuIGZvciBOb2RlIGJ1aWx0LWluc1xuICAgICAgICAvLyBsaWtlIFwiYnVmZmVyXCIpLiBCdW5kbGluZyBDSlMgaW50byBhbiBFU00gb3V0cHV0IGxlYXZlcyBubyBgcmVxdWlyZWBcbiAgICAgICAgLy8gaW4gc2NvcGUsIHNvIHRob3NlIGR5bmFtaWMgcmVxdWlyZXMgY3Jhc2ggYXQgcnVudGltZSB3aXRoIFwiRHluYW1pY1xuICAgICAgICAvLyByZXF1aXJlIG9mIC4uLiBpcyBub3Qgc3VwcG9ydGVkXCIgKGNvbmZpcm1lZCB2aWEgQ2xvdWRXYXRjaCBMb2dzKS5cbiAgICAgICAgLy8gSW5qZWN0IHRoZSBzYW1lIGNyZWF0ZVJlcXVpcmUgc2hpbSB1c2VkIGJ5IEluZ2VzdFN0YWNrJ3MgYnVuZGxpbmcgc29cbiAgICAgICAgLy8gdGhlIGJ1bmRsZWQgQ0pTIG1vZHVsZXMgY2FuIHJlc29sdmUgdGhlaXIgcmVxdWlyZXMgdW5kZXIgRVNNLlxuICAgICAgICBiYW5uZXI6XG4gICAgICAgICAgXCJpbXBvcnR7Y3JlYXRlUmVxdWlyZSBhcyBfX2NyZWF0ZVJlcXVpcmV9ZnJvbSdtb2R1bGUnO2NvbnN0IHJlcXVpcmU9X19jcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTGVhc3QtcHJpdmlsZWdlIElBTSwgVkVSSUZJRUQtUkVRVUlSRUQgKGVtcGlyaWNhbGx5IGNvbmZpcm1lZCB2aWEgYVxuICAgIC8vIGxpdmUgc2NvcGVkLXJvbGUgdGVzdCArIEFXUyBkb2NzIOKAlCBzZWUgZGVzaWduLm1kIElBTSBzZWN0aW9uKTogdGhlXG4gICAgLy8gQ2xvdWRXYXRjaCBQcm9tUUwgUXVlcnlNZXRyaWNzIG9wZXJhdGlvbiByZXF1aXJlcyBCT1RIIGFjdGlvbnMgYmVsb3cuXG4gICAgLy8gUmVzb3VyY2UgJyonIGJlY2F1c2UgdGhlc2UgQ2xvdWRXYXRjaCBtZXRyaWMtZGF0YSBhY3Rpb25zIGRvIG5vdFxuICAgIC8vIHN1cHBvcnQgcmVzb3VyY2UtbGV2ZWwgQVJOIHNjb3BpbmcgKGNvbmZpcm1lZCBieSB0aGUgNDAzIG1lc3NhZ2VcbiAgICAvLyBkdXJpbmcgdmVyaWZpY2F0aW9uLCB3aGljaCBuYW1lZCBhIGRhdGFzZXQgQVJOIENsb3VkV2F0Y2ggY29udHJvbHNcbiAgICAvLyBpbnRlcm5hbGx5LCBub3QgYSBjdXN0b21lci1zY29wYWJsZSByZXNvdXJjZSkuIE5vIEFjdGlvbjogJyonLlxuICAgIG1ldHJpY3NGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnY2xvdWR3YXRjaDpHZXRNZXRyaWNEYXRhJywgJ2Nsb3Vkd2F0Y2g6TGlzdE1ldHJpY3MnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyBOYXJyb3csIHJ1bi1BUk4tc2NvcGVkIGZhbGxiYWNrIHBlcm1pc3Npb24gZm9yIHRoZSB3aW5kb3ctcmVzb2x1dGlvblxuICAgIC8vIEdldFJ1biBjYWxsIChkZXNpZ24gXCJSdW4gd2luZG93XCIgZGVjaXNpb24pIOKAlCBvbmx5IHVzZWQgd2hlbiB0aGVcbiAgICAvLyBjYWxsZXIgb21pdHMgc3RhcnRUaW1lL2VuZFRpbWUuXG4gICAgY29uc3QgeyByZWdpb24sIGFjY291bnQgfSA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIG1ldHJpY3NGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnb21pY3M6R2V0UnVuJ10sXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOm9taWNzOiR7cmVnaW9ufToke2FjY291bnR9OnJ1bi8qYF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgY29uc3QgbWV0cmljc0RhdGFTb3VyY2UgPSB0aGlzLmFwaS5hZGRMYW1iZGFEYXRhU291cmNlKFxuICAgICAgJ01ldHJpY3NEYXRhU291cmNlJyxcbiAgICAgIG1ldHJpY3NGbixcbiAgICApO1xuXG4gICAgbWV0cmljc0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2dldFJ1bk1ldHJpY3NSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnZ2V0UnVuTWV0cmljcycsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogTGFtYmRhLWJhY2tlZCByZXNvbHZlciBmb3IgdGhlIGBnZXRSdW5Db3N0RXN0aW1hdGVgIHF1ZXJ5LlxuICAgKlxuICAgKiBNaXJyb3JzIGBhZGRNZXRyaWNzUmVzb2x2ZXIoKWA6IGEgTm9kZWpzRnVuY3Rpb25cbiAgICogKGluZ2VzdC9zcmMvY29zdEhhbmRsZXIudHMpIGV4cG9zZWQgYXMgYW4gQXBwU3luYyBMYW1iZGEgZGF0YSBzb3VyY2UsXG4gICAqIENvZ25pdG8tYXV0aG9yaXplZCBsaWtlIHRoZSBvdGhlciByZWFkcy4gSXQgYnVuZGxlcyB0aGUgc2FtZVxuICAgKiBgQHNtaXRoeS9zaWduYXR1cmUtdjRgL2BAYXdzLWNyeXB0by9zaGEyNTYtanNgIENKUy1pbi1FU00gZGVwcyAoZm9yIHRoZVxuICAgKiBEWU5BTUlDLXN0b3JhZ2UgUlVOX0ZJTEVTWVNURU0gUHJvbVFMIHF1ZXJ5KSwgc28gaXQgY2FycmllcyB0aGUgaWRlbnRpY2FsXG4gICAqIEVTTSBgY3JlYXRlUmVxdWlyZWAgYmFubmVyIHNoaW0uXG4gICAqXG4gICAqIExlYXN0LXByaXZpbGVnZSBJQU06XG4gICAqIC0gYHByaWNpbmc6R2V0UHJvZHVjdHNgL2BwcmljaW5nOkRlc2NyaWJlU2VydmljZXNgIG9uIFJlc291cmNlICcqJyDigJQgdGhlXG4gICAqICAgUHJpY2UgTGlzdCBBUEkgZG9lcyBOT1Qgc3VwcG9ydCByZXNvdXJjZS1sZXZlbCBzY29waW5nLCBhIERPQ1VNRU5URURcbiAgICogICBleGNlcHRpb24gdG8gdGhlIG5vLXdpbGRjYXJkLXJlc291cmNlIHBhdHRlcm4gKGxpa2UgdGhlIENsb3VkV2F0Y2hcbiAgICogICBtZXRyaWNzIGdyYW50KS4gTk9UIGEgd2lsZGNhcmQgYWN0aW9uLlxuICAgKiAtIGBjbG91ZHdhdGNoOkdldE1ldHJpY0RhdGFgL2BjbG91ZHdhdGNoOkxpc3RNZXRyaWNzYCBvbiBSZXNvdXJjZSAnKicg4oCUIHRoZVxuICAgKiAgIHNhbWUgQ2xvdWRXYXRjaCBQcm9tUUwgZ3JhbnQgYXMgdGhlIG1ldHJpY3MgTGFtYmRhIChubyByZXNvdXJjZS1sZXZlbFxuICAgKiAgIHNjb3BpbmcpLiBOT1QgYSB3aWxkY2FyZCBhY3Rpb24uXG4gICAqIC0gYG9taWNzOkdldFJ1bmAgc2NvcGVkIHRvIHJ1biBBUk5zIGZvciB0aGUgcnVuIHdpbmRvdy9zdG9yYWdlIGZpZWxkcy5cbiAgICogLSBhIER5bmFtb0RCIGdyYW50IHNjb3BlZCB0byB0aGUgc2luZ2xlLXRhYmxlIEFSTiwgbGltaXRlZCB0b1xuICAgKiAgIEdldEl0ZW0vUHV0SXRlbS9VcGRhdGVJdGVtIGZvciB0aGUgcmF0ZS1jYXJkIGNhY2hlIGl0ZW0uXG4gICAqXG4gICAqIE5vIHN0YXRlbWVudCBjYXJyaWVzIGBBY3Rpb246ICcqJ2AuXG4gICAqL1xuICBwcml2YXRlIGFkZENvc3RSZXNvbHZlcih0YWJsZTogRGF0YVN0YWNrWyd0YWJsZSddKTogdm9pZCB7XG4gICAgY29uc3QgY29zdEZuID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdDb3N0RnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBSdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgZW50cnk6IENPU1RfSEFORExFUl9FTlRSWSxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIHByb2plY3RSb290OiBJTkdFU1RfUFJPSkVDVF9ST09ULFxuICAgICAgZGVwc0xvY2tGaWxlUGF0aDogSU5HRVNUX0RFUFNfTE9DS19GSUxFLFxuICAgICAgdGltZW91dDogRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBDT1NUX1JFR0lPTjogU3RhY2sub2YodGhpcykucmVnaW9uLFxuICAgICAgICBDT1NUX1RBQkxFX05BTUU6IHRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgTU9OSVRPUklOR19IT1NUOiBgbW9uaXRvcmluZy4ke1N0YWNrLm9mKHRoaXMpLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgIFNJR05JTkdfU0VSVklDRTogJ21vbml0b3JpbmcnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIGZvcm1hdDogT3V0cHV0Rm9ybWF0LkVTTSxcbiAgICAgICAgLy8gc2lnbmF0dXJlLXY0L3NoYTI1NiBidW5kbGVkIChub3QgZXh0ZXJuYWxpemVkKSwgbGlrZSB0aGUgbWV0cmljc1xuICAgICAgICAvLyBMYW1iZGEg4oCUIEBhd3Mtc2RrLyogc3RheXMgZXh0ZXJuYWwgYXMgaXQgaXMgaW4gdGhlIE5vZGUgcnVudGltZS5cbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbJ0Bhd3Mtc2RrLyonXSxcbiAgICAgICAgLy8gSW5qZWN0IHRoZSBjcmVhdGVSZXF1aXJlIHNoaW0gc28gdGhlIGJ1bmRsZWQgQ0pTIGRlcHMgY2FuIHJlc29sdmVcbiAgICAgICAgLy8gdGhlaXIgZHluYW1pYyByZXF1aXJlcyB1bmRlciBFU00gKHNlZSBhZGRNZXRyaWNzUmVzb2x2ZXIpLlxuICAgICAgICBiYW5uZXI6XG4gICAgICAgICAgXCJpbXBvcnR7Y3JlYXRlUmVxdWlyZSBhcyBfX2NyZWF0ZVJlcXVpcmV9ZnJvbSdtb2R1bGUnO2NvbnN0IHJlcXVpcmU9X19jcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gUHJpY2UgTGlzdDogcmVhZC1vbmx5IGFjdGlvbnMuIFJlc291cmNlICcqJyBiZWNhdXNlIHRoZSBQcmljZSBMaXN0IEFQSVxuICAgIC8vIGRvZXMgTk9UIHN1cHBvcnQgcmVzb3VyY2UtbGV2ZWwgc2NvcGluZyDigJQgYW4gaW50ZW50aW9uYWwsIERPQ1VNRU5URURcbiAgICAvLyBleGNlcHRpb24gdG8gdGhlIG5vLXdpbGRjYXJkLXJlc291cmNlIHBhdHRlcm4sIGV4YWN0bHkgbGlrZSB0aGUgZXhpc3RpbmdcbiAgICAvLyBDbG91ZFdhdGNoIG1ldHJpY3MgZ3JhbnQuIE5PVCBhIHdpbGRjYXJkIGFjdGlvbiAoUmVxIDcuMSwgNy4yLCA3LjMpLlxuICAgIGNvc3RGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsncHJpY2luZzpHZXRQcm9kdWN0cycsICdwcmljaW5nOkRlc2NyaWJlU2VydmljZXMnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyBDbG91ZFdhdGNoIFByb21RTCAoRFlOQU1JQy1zdG9yYWdlIFJVTl9GSUxFU1lTVEVNIEdCLWhvdXJzKSwgc2FtZSBncmFudFxuICAgIC8vIGFzIHRoZSBtZXRyaWNzIExhbWJkYTsgUmVzb3VyY2UgJyonIChubyByZXNvdXJjZS1sZXZlbCBzY29waW5nKSwgTk9UIGFcbiAgICAvLyB3aWxkY2FyZCBhY3Rpb24uXG4gICAgY29zdEZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydjbG91ZHdhdGNoOkdldE1ldHJpY0RhdGEnLCAnY2xvdWR3YXRjaDpMaXN0TWV0cmljcyddLFxuICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIG9taWNzOkdldFJ1biBmb3IgdGhlIHJ1biB3aW5kb3cvc3RvcmFnZSBmaWVsZHMsIHNjb3BlZCB0byBydW4gQVJOcyAobm9cbiAgICAvLyB3aWxkY2FyZCBhY3Rpb24pLlxuICAgIGNvbnN0IHsgcmVnaW9uLCBhY2NvdW50IH0gPSBTdGFjay5vZih0aGlzKTtcbiAgICBjb3N0Rm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbJ29taWNzOkdldFJ1biddLFxuICAgICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpvbWljczoke3JlZ2lvbn06JHthY2NvdW50fTpydW4vKmBdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIER5bmFtb0RCIGFjY2Vzcywgc2NvcGVkIHRvIHRoZSBzaW5nbGUgdGFibGUgQVJOIChsZWFzdCBwcml2aWxlZ2UsIGxpa2VcbiAgICAvLyB0aGUgZXhpc3RpbmcgZ3JhbnRzKTpcbiAgICAvLyAgIC0gUXVlcnk6IGxpc3QgdGhlIHJ1bidzIHRhc2sgaXRlbXMgKFBLID0gUlVOIzxydW5JZD4sIFNLIGJlZ2luc193aXRoXG4gICAgLy8gICAgIFRBU0sjKSBpbiB0aGUgY29zdCBoYW5kbGVyJ3MgbG9hZFJ1blRhc2tzLlxuICAgIC8vICAgLSBHZXRJdGVtL1B1dEl0ZW0vVXBkYXRlSXRlbTogdGhlIHJlZ2lvbiByYXRlLWNhcmQgY2FjaGUgaXRlbS5cbiAgICB0YWJsZS5ncmFudChcbiAgICAgIGNvc3RGbixcbiAgICAgICdkeW5hbW9kYjpRdWVyeScsXG4gICAgICAnZHluYW1vZGI6R2V0SXRlbScsXG4gICAgICAnZHluYW1vZGI6UHV0SXRlbScsXG4gICAgICAnZHluYW1vZGI6VXBkYXRlSXRlbScsXG4gICAgKTtcblxuICAgIGNvbnN0IGNvc3REYXRhU291cmNlID0gdGhpcy5hcGkuYWRkTGFtYmRhRGF0YVNvdXJjZShcbiAgICAgICdDb3N0RGF0YVNvdXJjZScsXG4gICAgICBjb3N0Rm4sXG4gICAgKTtcblxuICAgIGNvc3REYXRhU291cmNlLmNyZWF0ZVJlc29sdmVyKCdnZXRSdW5Db3N0RXN0aW1hdGVSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnZ2V0UnVuQ29zdEVzdGltYXRlJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBMYW1iZGEtYmFja2VkIHJlc29sdmVyIGZvciB0aGUgYGxpc3RXb3JrZmxvd0dyb3Vwc2AgYW5kIGBnZXRXb3JrZmxvd1JlcG9ydGBcbiAgICogcXVlcmllcyAod29ya2Zsb3ctcGVyZm9ybWFuY2UtcmVwb3J0cykuIE9uZSBOb2RlanNGdW5jdGlvbiBiYWNrcyBib3RoXG4gICAqIGZpZWxkcywgZGlzcGF0Y2hlZCBvbiBgaW5mby5maWVsZE5hbWVgIChkaXJlY3QtTGFtYmRhLXJlc29sdmVyIHJvdXRlciwgbGlrZVxuICAgKiBgYWRkTG9nc1Jlc29sdmVyYCkuIEJvdGggcXVlcmllcyBhcmUgQ29nbml0by1hdXRob3JpemVkIGxpa2UgdGhlIG90aGVyXG4gICAqIHJlYWRzLlxuICAgKlxuICAgKiBMZWFzdC1wcml2aWxlZ2UgSUFNOiB0aGUgTGFtYmRhIG9ubHkgcmVhZHMgdGhlIHNpbmdsZSB0YWJsZSDigJQgYSBgUXVlcnlgIG9uXG4gICAqIEdTSTIgKHBlci1ncm91cCB3aW5kb3dlZCByZXBvcnQpIGFuZCBhIGBTY2FuYCAodGhlIGdyb3VwIHBpY2tlcikuIE5vXG4gICAqIENsb3VkV2F0Y2gvcHJpY2luZy9vbWljcyBncmFudHMgYXJlIG5lZWRlZCBiZWNhdXNlIHRoZSBSdW5fU3VtbWFyeSByb2xsdXBzXG4gICAqIGFyZSBwcmUtY29tcHV0ZWQgYXQgaW5nZXN0IHRpbWU7IHRoZSByZXBvcnQgaXMgYSBwdXJlIHJlYWQtYW5kLWFnZ3JlZ2F0ZS5cbiAgICovXG4gIHByaXZhdGUgYWRkUmVwb3J0c1Jlc29sdmVyKFxuICAgIHRhYmxlOiBEYXRhU3RhY2tbJ3RhYmxlJ10sXG4gICAgZ3NpMk5hbWU6IHN0cmluZyxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgcmVwb3J0c0ZuID0gbmV3IE5vZGVqc0Z1bmN0aW9uKHRoaXMsICdSZXBvcnRzRnVuY3Rpb24nLCB7XG4gICAgICBydW50aW1lOiBSdW50aW1lLk5PREVKU18yMF9YLFxuICAgICAgZW50cnk6IFJFUE9SVFNfSEFORExFUl9FTlRSWSxcbiAgICAgIGhhbmRsZXI6ICdoYW5kbGVyJyxcbiAgICAgIHByb2plY3RSb290OiBJTkdFU1RfUFJPSkVDVF9ST09ULFxuICAgICAgZGVwc0xvY2tGaWxlUGF0aDogSU5HRVNUX0RFUFNfTE9DS19GSUxFLFxuICAgICAgdGltZW91dDogRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBSRVBPUlRTX1JFR0lPTjogU3RhY2sub2YodGhpcykucmVnaW9uLFxuICAgICAgICBSRVBPUlRTX1RBQkxFX05BTUU6IHRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgUkVQT1JUU19HU0kyX05BTUU6IGdzaTJOYW1lLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIGZvcm1hdDogT3V0cHV0Rm9ybWF0LkVTTSxcbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbJ0Bhd3Mtc2RrLyonXSxcbiAgICAgICAgYmFubmVyOlxuICAgICAgICAgIFwiaW1wb3J0e2NyZWF0ZVJlcXVpcmUgYXMgX19jcmVhdGVSZXF1aXJlfWZyb20nbW9kdWxlJztjb25zdCByZXF1aXJlPV9fY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpO1wiLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFJlYWQtb25seSBEeW5hbW9EQiBhY2Nlc3Mgc2NvcGVkIHRvIHRoZSB0YWJsZSAoYW5kIGl0cyBpbmRleGVzLCB3aGljaFxuICAgIC8vIGBncmFudGAgY292ZXJzIHZpYSB0aGUgdGFibGUgQVJOICsgYC9pbmRleC8qYCkuIFF1ZXJ5IGJhY2tzIHRoZSBwZXItZ3JvdXBcbiAgICAvLyBHU0kyIHJlcG9ydDsgU2NhbiBiYWNrcyB0aGUgZ3JvdXAgcGlja2VyLiBObyB3cml0ZSBhY3Rpb25zLlxuICAgIHRhYmxlLmdyYW50KHJlcG9ydHNGbiwgJ2R5bmFtb2RiOlF1ZXJ5JywgJ2R5bmFtb2RiOlNjYW4nKTtcblxuICAgIGNvbnN0IHJlcG9ydHNEYXRhU291cmNlID0gdGhpcy5hcGkuYWRkTGFtYmRhRGF0YVNvdXJjZShcbiAgICAgICdSZXBvcnRzRGF0YVNvdXJjZScsXG4gICAgICByZXBvcnRzRm4sXG4gICAgKTtcblxuICAgIHJlcG9ydHNEYXRhU291cmNlLmNyZWF0ZVJlc29sdmVyKCdsaXN0V29ya2Zsb3dHcm91cHNSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnbGlzdFdvcmtmbG93R3JvdXBzJyxcbiAgICB9KTtcbiAgICByZXBvcnRzRGF0YVNvdXJjZS5jcmVhdGVSZXNvbHZlcignZ2V0V29ya2Zsb3dSZXBvcnRSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnZ2V0V29ya2Zsb3dSZXBvcnQnLFxuICAgIH0pO1xuICAgIHJlcG9ydHNEYXRhU291cmNlLmNyZWF0ZVJlc29sdmVyKCdsaXN0V29ya2Zsb3dSdW5Qb2ludHNSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnbGlzdFdvcmtmbG93UnVuUG9pbnRzJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTdGFjayBvdXRwdXRzIGNvbnN1bWVkIGJ5IHRoZSBmcm9udGVuZCBidWlsZCAodGFzayAxMi4xKS5cbiAgICpcbiAgICogVGhlIEFwcFN5bmMgR3JhcGhRTCBlbmRwb2ludCBVUkwsIENvZ25pdG8gdXNlciBwb29sIElELCBhcHAgY2xpZW50IElELCBhbmRcbiAgICogcmVnaW9uIGFyZSBlbWl0dGVkIHdpdGggZXhwb3J0IG5hbWVzIHNvIHRoZSBWaXRlIGJ1aWxkIGNhbiBpbmplY3QgdGhlbSBhdFxuICAgKiBidWlsZCB0aW1lIGFuZCB0aGUgU1BBIGNhcnJpZXMgbm8gaGFyZGNvZGVkIGVudmlyb25tZW50IHZhbHVlcyAoUmVxIDExLjcpLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRPdXRwdXRzKCk6IHZvaWQge1xuICAgIGNvbnN0IG91dHB1dHM6IFJlYWRvbmx5QXJyYXk8e1xuICAgICAgaWQ6IHN0cmluZztcbiAgICAgIHZhbHVlOiBzdHJpbmc7XG4gICAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAgIH0+ID0gW1xuICAgICAge1xuICAgICAgICBpZDogJ0dyYXBocWxBcGlVcmwnLFxuICAgICAgICB2YWx1ZTogdGhpcy5hcGkuZ3JhcGhxbFVybCxcbiAgICAgICAgZGVzY3JpcHRpb246ICdBcHBTeW5jIEdyYXBoUUwgZW5kcG9pbnQgVVJMLicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ1VzZXJQb29sSWQnLFxuICAgICAgICB2YWx1ZTogdGhpcy51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gdXNlciBwb29sIElELicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ1VzZXJQb29sQ2xpZW50SWQnLFxuICAgICAgICB2YWx1ZTogdGhpcy51c2VyUG9vbENsaWVudC51c2VyUG9vbENsaWVudElkLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0NvZ25pdG8gYXBwIGNsaWVudCBJRCBmb3IgdGhlIFNQQS4nLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdSZWdpb24nLFxuICAgICAgICB2YWx1ZTogdGhpcy5yZWdpb24sXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQVdTIHJlZ2lvbiB0aGUgQVBJIGlzIGRlcGxveWVkIGluLicsXG4gICAgICB9LFxuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IHsgaWQsIHZhbHVlLCBkZXNjcmlwdGlvbiB9IG9mIG91dHB1dHMpIHtcbiAgICAgIG5ldyBDZm5PdXRwdXQodGhpcywgaWQsIHtcbiAgICAgICAgdmFsdWUsXG4gICAgICAgIGRlc2NyaXB0aW9uLFxuICAgICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tJHtpZH1gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEFQUFNZTkNfSlMgcmVhZCByZXNvbHZlcnMgb24gdGhlIER5bmFtb0RCIGRhdGEgc291cmNlLlxuICAgKlxuICAgKiAtIGxpc3RSdW5zOiBRdWVyeSBHU0kxIChHU0kxUEsgPSAnUlVOUycpIGRlc2NlbmRpbmcgYnkgdXBkYXRlZEF0IHdpdGhcbiAgICogICBzZXJ2ZXItc2lkZSBsaW1pdCB2YWxpZGF0aW9uICgx4oCTMTAwLCBkZWZhdWx0IDI1KSBhbmQgbmV4dFRva2VuXG4gICAqICAgcGFnaW5hdGlvbjsgb3V0LW9mLXJhbmdlIGxpbWl0cyBhbmQgbWFsZm9ybWVkL2V4cGlyZWQgdG9rZW5zIGFyZSByZWplY3RlZFxuICAgKiAgIChSZXEgNS4yLCA1LjMsIDUuNCwgNS41KS5cbiAgICogLSBnZXRSdW46IEdldEl0ZW0gUEsgPSBTSyA9ICdSVU4jPHJ1bklkPic7IG51bGwgKG5vIGVycm9yKSB3aGVuIGFic2VudFxuICAgKiAgIChSZXEgNS42LCA1LjcpLlxuICAgKiAtIGxpc3RUYXNrc0ZvclJ1bjogUXVlcnkgUEsgPSAnUlVOIzxydW5JZD4nLCBTSyBiZWdpbnNfd2l0aCAnVEFTSyMnO1xuICAgKiAgIHJldHVybnMgaXRlbXMgb3IgYW4gZW1wdHkgbGlzdCAoUmVxIDUuOCkuXG4gICAqIC0gZ2V0U3RhdGljR3JhcGg6IEdldEl0ZW0gUEsgPSBTSyA9ICdXRiM8d29ya2Zsb3dJZD4jPHdvcmtmbG93VmVyc2lvbk5hbWU+JztcbiAgICogICBudWxsIChubyBlcnJvcikgd2hlbiBhYnNlbnQgb3IgYSBmYWlsdXJlLW9ubHkgbWFya2VyIChSZXEgNi42KS4gR2V0SXRlbVxuICAgKiAgIG9ubHksIHdpdGhpbiB0aGUgZXhpc3RpbmcgcmVhZC1vbmx5IGdyYW50IOKAlCBubyBuZXcgZGF0YSBzb3VyY2UvSUFNLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRSZWFkUmVzb2x2ZXJzKGRhdGFTb3VyY2U6IER5bmFtb0RiRGF0YVNvdXJjZSk6IHZvaWQge1xuICAgIGNvbnN0IHJlYWRzOiBSZWFkb25seUFycmF5PHsgZmllbGQ6IHN0cmluZzsgZmlsZTogc3RyaW5nIH0+ID0gW1xuICAgICAgeyBmaWVsZDogJ2xpc3RSdW5zJywgZmlsZTogJ2xpc3RSdW5zLmpzJyB9LFxuICAgICAgeyBmaWVsZDogJ2dldFJ1bicsIGZpbGU6ICdnZXRSdW4uanMnIH0sXG4gICAgICB7IGZpZWxkOiAnbGlzdFRhc2tzRm9yUnVuJywgZmlsZTogJ2xpc3RUYXNrc0ZvclJ1bi5qcycgfSxcbiAgICAgIHsgZmllbGQ6ICdnZXRTdGF0aWNHcmFwaCcsIGZpbGU6ICdnZXRTdGF0aWNHcmFwaC5qcycgfSxcbiAgICBdO1xuXG4gICAgZm9yIChjb25zdCB7IGZpZWxkLCBmaWxlIH0gb2YgcmVhZHMpIHtcbiAgICAgIG5ldyBSZXNvbHZlcih0aGlzLCBgJHtmaWVsZH1SZXNvbHZlcmAsIHtcbiAgICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICAgIGZpZWxkTmFtZTogZmllbGQsXG4gICAgICAgIGRhdGFTb3VyY2UsXG4gICAgICAgIHJ1bnRpbWU6IEZ1bmN0aW9uUnVudGltZS5KU18xXzBfMCxcbiAgICAgICAgY29kZTogQ29kZS5mcm9tQXNzZXQocmVzb2x2ZXJQYXRoKGZpbGUpKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBQYXNzLXRocm91Z2ggcmVzb2x2ZXJzIGZvciB0aGUgSUFNLWF1dGhvcml6ZWQgcHVibGlzaCBtdXRhdGlvbnMuXG4gICAqXG4gICAqIHB1Ymxpc2hSdW5VcGRhdGUgLyBwdWJsaXNoVGFza1VwZGF0ZSBjYXJyeSBubyBkYXRhLXNvdXJjZSB3b3JrOiB0aGV5IGVjaG9cbiAgICogdGhlaXIgaW5wdXQgb24gYSBOT05FIChsb2NhbCkgZGF0YSBzb3VyY2Ugc28gQGF3c19zdWJzY3JpYmUgZmFucyB0aGVcbiAgICogcGF5bG9hZCBvdXQgdG8gb25SdW5VcGRhdGVkIC8gb25UYXNrVXBkYXRlZCBzdWJzY3JpYmVycyAoUmVxIDQuNSwgNC42KS4gVGhlXG4gICAqIGluZ2VzdCBMYW1iZGEgaGFzIGFscmVhZHkgcGVyc2lzdGVkIHRoZSBydW4vdGFzayBiZWZvcmUgY2FsbGluZyB0aGVtLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRQdWJsaXNoUmVzb2x2ZXJzKCk6IHZvaWQge1xuICAgIGNvbnN0IG5vbmVEYXRhU291cmNlID0gdGhpcy5hcGkuYWRkTm9uZURhdGFTb3VyY2UoJ1B1Ymxpc2hOb25lRGF0YVNvdXJjZScpO1xuXG4gICAgZm9yIChjb25zdCBmaWVsZCBvZiBbJ3B1Ymxpc2hSdW5VcGRhdGUnLCAncHVibGlzaFRhc2tVcGRhdGUnXSkge1xuICAgICAgbmV3IFJlc29sdmVyKHRoaXMsIGAke2ZpZWxkfVJlc29sdmVyYCwge1xuICAgICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgICB0eXBlTmFtZTogJ011dGF0aW9uJyxcbiAgICAgICAgZmllbGROYW1lOiBmaWVsZCxcbiAgICAgICAgZGF0YVNvdXJjZTogbm9uZURhdGFTb3VyY2UsXG4gICAgICAgIHJ1bnRpbWU6IEZ1bmN0aW9uUnVudGltZS5KU18xXzBfMCxcbiAgICAgICAgY29kZTogQ29kZS5mcm9tQXNzZXQocmVzb2x2ZXJQYXRoKCdwdWJsaXNoUGFzc3Rocm91Z2guanMnKSksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cbiJdfQ==