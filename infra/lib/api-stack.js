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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBpLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDJDQUE2QjtBQUM3Qiw2Q0FBcUU7QUFDckUseURBUWlDO0FBQ2pDLHlEQUlpQztBQUNqQyx1REFBaUQ7QUFDakQscUVBQTZFO0FBQzdFLGlEQUE4RDtBQUk5RCxnRkFBZ0Y7QUFDaEYsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ3ZFLE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUNuRixNQUFNLHFCQUFxQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxFQUFFLG1CQUFtQixDQUFDLENBQUM7QUFDekYsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixFQUFFLG1CQUFtQixDQUFDLENBQUM7QUFFbEYsb0VBQW9FO0FBQ3BFLE1BQU0sZUFBZSxHQUFHLHdCQUF3QixDQUFDO0FBT2pELGlGQUFpRjtBQUNqRixNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLGdCQUFnQixDQUFDLENBQUM7QUFFNUUsaUVBQWlFO0FBQ2pFLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxXQUFXLENBQUMsQ0FBQztBQUU5RCxzREFBc0Q7QUFDdEQsU0FBUyxZQUFZLENBQUMsSUFBWTtJQUNoQyxPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxFQUFFLElBQUksQ0FBQyxDQUFDO0FBQ3hD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LEVBQUUsS0FBSztnQkFDaEIsVUFBVTtnQkFDVixPQUFPLEVBQUUsNkJBQWUsQ0FBQyxRQUFRO2dCQUNqQyxJQUFJLEVBQUUsa0JBQUksQ0FBQyxTQUFTLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxDQUFDO2FBQ3pDLENBQUMsQ0FBQztRQUNMLENBQUM7SUFDSCxDQUFDO0lBRUQ7Ozs7Ozs7T0FPRztJQUNLLG1CQUFtQjtRQUN6QixNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLHVCQUF1QixDQUFDLENBQUM7UUFFM0UsS0FBSyxNQUFNLEtBQUssSUFBSSxDQUFDLGtCQUFrQixFQUFFLG1CQUFtQixDQUFDLEVBQUUsQ0FBQztZQUM5RCxJQUFJLHNCQUFRLENBQUMsSUFBSSxFQUFFLEdBQUcsS0FBSyxVQUFVLEVBQUU7Z0JBQ3JDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztnQkFDYixRQUFRLEVBQUUsVUFBVTtnQkFDcEIsU0FBUyxFQUFFLEtBQUs7Z0JBQ2hCLFVBQVUsRUFBRSxjQUFjO2dCQUMxQixPQUFPLEVBQUUsNkJBQWUsQ0FBQyxRQUFRO2dCQUNqQyxJQUFJLEVBQUUsa0JBQUksQ0FBQyxTQUFTLENBQUMsWUFBWSxDQUFDLHVCQUF1QixDQUFDLENBQUM7YUFDNUQsQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUNILENBQUM7Q0FDRjtBQXpWRCw0QkF5VkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgQ2ZuT3V0cHV0LCBEdXJhdGlvbiwgU3RhY2ssIFN0YWNrUHJvcHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQge1xuICBBdXRob3JpemF0aW9uVHlwZSxcbiAgQ29kZSxcbiAgRGVmaW5pdGlvbixcbiAgRHluYW1vRGJEYXRhU291cmNlLFxuICBGdW5jdGlvblJ1bnRpbWUsXG4gIEdyYXBocWxBcGksXG4gIFJlc29sdmVyLFxufSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBwc3luYyc7XG5pbXBvcnQge1xuICBBY2NvdW50UmVjb3ZlcnksXG4gIFVzZXJQb29sLFxuICBVc2VyUG9vbENsaWVudCxcbn0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZ25pdG8nO1xuaW1wb3J0IHsgUnVudGltZSB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgTm9kZWpzRnVuY3Rpb24sIE91dHB1dEZvcm1hdCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzJztcbmltcG9ydCB7IEVmZmVjdCwgUG9saWN5U3RhdGVtZW50IH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCB7IERhdGFTdGFjayB9IGZyb20gJy4vZGF0YS1zdGFjayc7XG5cbi8qKiBUaGUgaW5nZXN0IHBhY2thZ2UgZGlyIChzaWJsaW5nIG9mIGluZnJhLyksIHdoZXJlIHRoZSBsb2dzIGhhbmRsZXIgbGl2ZXMuICovXG5jb25zdCBJTkdFU1RfUFJPSkVDVF9ST09UID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJy4uJywgJ2luZ2VzdCcpO1xuY29uc3QgTE9HU19IQU5ETEVSX0VOVFJZID0gcGF0aC5qb2luKElOR0VTVF9QUk9KRUNUX1JPT1QsICdzcmMnLCAnbG9nc0hhbmRsZXIudHMnKTtcbmNvbnN0IE1FVFJJQ1NfSEFORExFUl9FTlRSWSA9IHBhdGguam9pbihJTkdFU1RfUFJPSkVDVF9ST09ULCAnc3JjJywgJ21ldHJpY3NIYW5kbGVyLnRzJyk7XG5jb25zdCBJTkdFU1RfREVQU19MT0NLX0ZJTEUgPSBwYXRoLmpvaW4oSU5HRVNUX1BST0pFQ1RfUk9PVCwgJ3BhY2thZ2UtbG9jay5qc29uJyk7XG5cbi8qKiBIZWFsdGhPbWljcyB3cml0ZXMgYWxsIHJ1biBsb2dzIHRvIHRoaXMgQ2xvdWRXYXRjaCBsb2cgZ3JvdXAuICovXG5jb25zdCBPTUlDU19MT0dfR1JPVVAgPSAnL2F3cy9vbWljcy9Xb3JrZmxvd0xvZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBpU3RhY2tQcm9wcyBleHRlbmRzIFN0YWNrUHJvcHMge1xuICAvKiogVGhlIGRhdGEgbGF5ZXIgdGhpcyBBUEkgcmVhZHMgZnJvbS4gRXN0YWJsaXNoZXMgZGVwbG95IG9yZGVyaW5nLiAqL1xuICByZWFkb25seSBkYXRhU3RhY2s6IERhdGFTdGFjaztcbn1cblxuLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIEdyYXBoUUwgc2NoZW1hIChyZXNvbHZlcyB1bmRlciBib3RoIHRzLW5vZGUgYW5kIHRzYykuICovXG5jb25zdCBTQ0hFTUFfUEFUSCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdncmFwaHFsJywgJ3NjaGVtYS5ncmFwaHFsJyk7XG5cbi8qKiBBYnNvbHV0ZSBwYXRoIHRvIHRoZSBBUFBTWU5DX0pTIHJlc29sdmVyIGFzc2V0cyBkaXJlY3RvcnkuICovXG5jb25zdCBSRVNPTFZFUlNfRElSID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ3Jlc29sdmVycycpO1xuXG4vKiogQWJzb2x1dGUgcGF0aCB0byBhIHNpbmdsZSBuYW1lZCByZXNvbHZlciBhc3NldC4gKi9cbmZ1bmN0aW9uIHJlc29sdmVyUGF0aChuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5qb2luKFJFU09MVkVSU19ESVIsIG5hbWUpO1xufVxuXG4vKipcbiAqIEFwaVN0YWNrIOKAlCB0aGUgQVBJIGxheWVyLlxuICpcbiAqIE93bnMgdGhlIEFwcFN5bmMgR3JhcGhRTCBBUEkgKHNjaGVtYSwgSlMgcmVzb2x2ZXJzIG9uIER5bmFtb0RCLCBvcHRpb25hbFxuICogTGFtYmRhIGRhdGEgc291cmNlKSwgdGhlIENvZ25pdG8gdXNlciBwb29sICsgYXBwIGNsaWVudCwgYW5kIGF1dGhvcml6YXRpb25cbiAqIChkZWZhdWx0IENvZ25pdG8gdXNlciBwb29sLCBJQU0gZm9yIHRoZSBpbmdlc3QgcHVibGlzaCBtdXRhdGlvbnMpLlxuICpcbiAqIFRoZSBDb2duaXRvIHVzZXIgcG9vbCBhbmQgYXBwIGNsaWVudCBhcmUgY3JlYXRlZCBCRUZPUkUgdGhlIEFQSSBzb1xuICogYXV0aG9yaXphdGlvbiBjYW4gbmV2ZXIgYmUgd2lyZWQgYmVmb3JlIHRoZSBwb29sIGV4aXN0cyAoUmVxIDExLjEwKS4gVGhlIEFQSVxuICogZGVmYXVsdCBhdXRob3JpemF0aW9uIG1vZGUgaXMgdGhlIENvZ25pdG8gdXNlciBwb29sIChSZXEgNS4xMiwgMTEuNikgd2l0aCBJQU1cbiAqIGFzIGFuIGFkZGl0aW9uYWwgbW9kZSBzbyB0aGUgaW5nZXN0IExhbWJkYSBjYW4gaW52b2tlIHRoZSBJQU0tYXV0aG9yaXplZFxuICogcHVibGlzaCBtdXRhdGlvbnMgKFJlcSA0LjMsIDQuNCkuXG4gKlxuICogQVBQU1lOQ19KUyAoSlMgcnVudGltZSkgcmVzb2x2ZXJzIGJhY2sgdGhlIHJlYWQgcXVlcmllcyBkaXJlY3RseSBvbiBhXG4gKiBEeW5hbW9EQiBkYXRhIHNvdXJjZSAoUmVxIDUuMTEpOiBsaXN0UnVucyAoR1NJMSBkZXNjZW5kaW5nLCBzZXJ2ZXItc2lkZSBsaW1pdFxuICogdmFsaWRhdGlvbiwgbmV4dFRva2VuIHBhZ2luYXRpb24g4oCUIFJlcSA1LjLigJM1LjUpLCBnZXRSdW4gKEdldEl0ZW0sIG51bGwgd2hlblxuICogYWJzZW50IOKAlCBSZXEgNS42LCA1LjcpLCBhbmQgbGlzdFRhc2tzRm9yUnVuIChRdWVyeSBieSBydW4g4oCUIFJlcSA1LjgpLiBUaGVcbiAqIHB1Ymxpc2ggbXV0YXRpb25zIGFyZSBwYXNzLXRocm91Z2ggcmVzb2x2ZXJzIG9uIGEgTk9ORSBkYXRhIHNvdXJjZSB0aGF0IGVjaG9cbiAqIHRoZWlyIGlucHV0IHNvIEBhd3Nfc3Vic2NyaWJlIGZhbnMgb3V0IHRvIG9uUnVuVXBkYXRlZCAvIG9uVGFza1VwZGF0ZWRcbiAqIChSZXEgNC41LCA0LjYpLlxuICpcbiAqIFRoZSBEeW5hbW9EQiBkYXRhIHNvdXJjZSBpcyBwcm92aXNpb25lZCBSRUFELU9OTFkgKGByZWFkT25seUFjY2VzczogdHJ1ZWApXG4gKiBzbyBpdHMgc2VydmljZSByb2xlIGNhbiBvbmx5IHJlYWQgdGhlIHRhYmxlL0dTSSBmb3IgdGhlIHF1ZXJ5IHJlc29sdmVycyBhbmRcbiAqIG5ldmVyIHdyaXRlIOKAlCBkZWxpYmVyYXRlbHkgbmFycm93ZXIgdGhhbiBDREsncyBkZWZhdWx0XG4gKiBgYWRkRHluYW1vRGJEYXRhU291cmNlYCwgd2hpY2ggZ3JhbnRzIHJlYWQrd3JpdGUuIFRoZSBncmFudCBjYXJyaWVzIG5vXG4gKiBgQWN0aW9uOiBcIipcImAgYW5kIG5vIGBSZXNvdXJjZTogXCIqXCJgIChSZXEgMTEuMikuXG4gKlxuICogVGhlIEFwcFN5bmMgZW5kcG9pbnQgVVJMLCBDb2duaXRvIHVzZXIgcG9vbCBJRCwgYXBwIGNsaWVudCBJRCwgYW5kIHJlZ2lvbiBhcmVcbiAqIGVtaXR0ZWQgYXMgc3RhY2sgb3V0cHV0cyAod2l0aCBleHBvcnQgbmFtZXMpIHNvIHRoZSBmcm9udGVuZCBidWlsZCBjYW4gaW5qZWN0XG4gKiB0aGVtIGF0IGJ1aWxkIHRpbWUgKFJlcSAxMS43LCB0YXNrIDEyLjEpLlxuICpcbiAqIFJlcXVpcmVtZW50czogNS4xLCA1LjIsIDUuMywgNS40LCA1LjUsIDUuNiwgNS43LCA1LjgsIDUuOSwgNS4xMCwgNS4xMSwgNS4xMixcbiAqIDUuMTMsIDQuNSwgNC42LCAxMS4yLCAxMS42LCAxMS43LCAxMS4xMC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwaVN0YWNrIGV4dGVuZHMgU3RhY2sge1xuICAvKiogVGhlIEFwcFN5bmMgR3JhcGhRTCBBUEkuICovXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IEdyYXBocWxBcGk7XG5cbiAgLyoqIFRoZSBDb2duaXRvIHVzZXIgcG9vbCBndWFyZGluZyBpbnRlcmFjdGl2ZSBhY2Nlc3MgdG8gdGhlIEFQSS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sOiBVc2VyUG9vbDtcblxuICAvKiogVGhlIENvZ25pdG8gYXBwIGNsaWVudCB0aGUgU1BBIGF1dGhlbnRpY2F0ZXMgYWdhaW5zdC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sQ2xpZW50OiBVc2VyUG9vbENsaWVudDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBpU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gUHJvdmlzaW9uIHRoZSBDb2duaXRvIHVzZXIgcG9vbCArIGFwcCBjbGllbnQgRklSU1QsIGJlZm9yZSB0aGUgQVBJJ3NcbiAgICAvLyBhdXRob3JpemF0aW9uIGlzIGNvbmZpZ3VyZWQsIHNvIHRoZSBwb29sIGFsd2F5cyBleGlzdHMgYmVmb3JlIGl0IGlzXG4gICAgLy8gcmVmZXJlbmNlZCAoUmVxIDExLjEwKS5cbiAgICB0aGlzLnVzZXJQb29sID0gbmV3IFVzZXJQb29sKHRoaXMsICdVc2VyUG9vbCcsIHtcbiAgICAgIHNlbGZTaWduVXBFbmFibGVkOiBmYWxzZSxcbiAgICAgIHNpZ25JbkFsaWFzZXM6IHsgZW1haWw6IHRydWUgfSxcbiAgICAgIHN0YW5kYXJkQXR0cmlidXRlczoge1xuICAgICAgICBlbWFpbDogeyByZXF1aXJlZDogdHJ1ZSwgbXV0YWJsZTogdHJ1ZSB9LFxuICAgICAgfSxcbiAgICAgIGFjY291bnRSZWNvdmVyeTogQWNjb3VudFJlY292ZXJ5LkVNQUlMX09OTFksXG4gICAgfSk7XG5cbiAgICB0aGlzLnVzZXJQb29sQ2xpZW50ID0gdGhpcy51c2VyUG9vbC5hZGRDbGllbnQoJ1NwYUNsaWVudCcsIHtcbiAgICAgIGF1dGhGbG93czogeyB1c2VyU3JwOiB0cnVlIH0sXG4gICAgfSk7XG5cbiAgICAvLyBBcHBTeW5jIEdyYXBoUUwgQVBJLiBEZWZhdWx0IGF1dGhvcml6YXRpb24gaXMgdGhlIENvZ25pdG8gdXNlciBwb29sIHNvXG4gICAgLy8gaW50ZXJhY3RpdmUgcXVlcmllcyBhbmQgc3Vic2NyaXB0aW9ucyByZXF1aXJlIGEgdmFsaWQgcG9vbC1pc3N1ZWQgdG9rZW5cbiAgICAvLyAoUmVxIDUuMTIsIDExLjYpOyByZXF1ZXN0cyB3aXRob3V0IHZhbGlkIGNyZWRlbnRpYWxzIGFyZSByZWplY3RlZCB3aXRob3V0XG4gICAgLy8gcmV0dXJuaW5nIGRhdGEgKFJlcSA1LjEzKS4gSUFNIGlzIGFkZGVkIGFzIGFuIGFkZGl0aW9uYWwgYXV0aG9yaXphdGlvblxuICAgIC8vIG1vZGUgc28gb25seSB0aGUgaW5nZXN0IExhbWJkYSdzIHJvbGUgY2FuIGNhbGwgdGhlIElBTS1hdXRob3JpemVkIHB1Ymxpc2hcbiAgICAvLyBtdXRhdGlvbnMgKFJlcSA0LjMsIDQuNCkuIFRoZSBzY2hlbWEgZXhwb3NlcyB0aGUgc3Vic2NyaXB0aW9ucyBhbmRcbiAgICAvLyBub24tbnVsbGFibGUgc3RvcmVkIGF0dHJpYnV0ZXMgKFJlcSA1LjEsIDUuOSwgNS4xMCkuXG4gICAgdGhpcy5hcGkgPSBuZXcgR3JhcGhxbEFwaSh0aGlzLCAnR3JhcGhxbEFwaScsIHtcbiAgICAgIG5hbWU6ICdIZWFsdGhPbWljc1dvcmtmbG93RGFzaGJvYXJkJyxcbiAgICAgIGRlZmluaXRpb246IERlZmluaXRpb24uZnJvbUZpbGUoU0NIRU1BX1BBVEgpLFxuICAgICAgYXV0aG9yaXphdGlvbkNvbmZpZzoge1xuICAgICAgICBkZWZhdWx0QXV0aG9yaXphdGlvbjoge1xuICAgICAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBBdXRob3JpemF0aW9uVHlwZS5VU0VSX1BPT0wsXG4gICAgICAgICAgdXNlclBvb2xDb25maWc6IHsgdXNlclBvb2w6IHRoaXMudXNlclBvb2wgfSxcbiAgICAgICAgfSxcbiAgICAgICAgYWRkaXRpb25hbEF1dGhvcml6YXRpb25Nb2RlczogW1xuICAgICAgICAgIHsgYXV0aG9yaXphdGlvblR5cGU6IEF1dGhvcml6YXRpb25UeXBlLklBTSB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIER5bmFtb0RCIGRhdGEgc291cmNlIGJhY2tlZCBieSB0aGUgc2luZ2xlIHRhYmxlIGZyb20gdGhlIGRhdGEgbGF5ZXIuIFRoZVxuICAgIC8vIHJlYWQgcXVlcmllcyByZXNvbHZlIGRpcmVjdGx5IGFnYWluc3QgaXQgd2l0aCBBUFBTWU5DX0pTIHJlc29sdmVyc1xuICAgIC8vIChSZXEgNS4xMSkuXG4gICAgLy9cbiAgICAvLyBUaGUgZGF0YSBzb3VyY2UgYXNzdW1lcyBhIGRlZGljYXRlZCBBcHBTeW5jIHNlcnZpY2Ugcm9sZSBzY29wZWQgdG9cbiAgICAvLyBSRUFELU9OTFkgRHluYW1vREIgYWNjZXNzLiBgcmVhZE9ubHlBY2Nlc3M6IHRydWVgIG1ha2VzIENESyBncmFudCBvbmx5XG4gICAgLy8gcmVhZCBkYXRhIGFjdGlvbnMgb24gdGhlIHRhYmxlIGFuZCBpdHMgaW5kZXhlcyBhbmQgTkVWRVIgYW55IHdyaXRlIGFjdGlvblxuICAgIC8vICh0aGUgZGVmYXVsdCBgYWRkRHluYW1vRGJEYXRhU291cmNlYCB3b3VsZCBncmFudCByZWFkK3dyaXRlKS4gVGhlIHJlYWRcbiAgICAvLyBncmFudCBjYXJyaWVzIG5vIGBBY3Rpb246IFwiKlwiYCBhbmQgbm8gYFJlc291cmNlOiBcIipcImAg4oCUIGl0IGlzIGNvbmZpbmVkIHRvXG4gICAgLy8gdGhlIHRhYmxlJ3Mgb3duIEFSTiBhbmQgaW5kZXggQVJOcyAoUmVxIDExLjIpLiBUaGUgcXVlcnkgcmVzb2x2ZXJzIG9ubHlcbiAgICAvLyBldmVyIEdldEl0ZW0gKGdldFJ1bikgb3IgUXVlcnkgKGxpc3RSdW5zIHZpYSBHU0kxLCBsaXN0VGFza3NGb3JSdW4gdmlhXG4gICAgLy8gdGhlIHRhYmxlKSwgYWxsIG9mIHdoaWNoIGZhbGwgd2l0aGluIHRoaXMgcmVhZC1vbmx5IGdyYW50LlxuICAgIGNvbnN0IGR5bmFtb0RhdGFTb3VyY2UgPSBuZXcgRHluYW1vRGJEYXRhU291cmNlKHRoaXMsICdEeW5hbW9EYXRhU291cmNlJywge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIHRhYmxlOiBwcm9wcy5kYXRhU3RhY2sudGFibGUsXG4gICAgICByZWFkT25seUFjY2VzczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkUmVhZFJlc29sdmVycyhkeW5hbW9EYXRhU291cmNlKTtcbiAgICB0aGlzLmFkZFB1Ymxpc2hSZXNvbHZlcnMoKTtcbiAgICB0aGlzLmFkZExvZ3NSZXNvbHZlcigpO1xuICAgIHRoaXMuYWRkTWV0cmljc1Jlc29sdmVyKCk7XG5cbiAgICB0aGlzLmFkZE91dHB1dHMoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBMYW1iZGEtYmFja2VkIHJlc29sdmVyIGZvciB0aGUgYGdldFJ1bkxvZ3NgIGFuZCBgZ2V0RXJyb3JFeGNlcnB0YCBxdWVyaWVzLlxuICAgKlxuICAgKiBBUFBTWU5DX0pTIHJlc29sdmVycyBjYW5ub3QgY2FsbCBDbG91ZFdhdGNoIExvZ3MsIHNvIGJvdGggcXVlcmllcyBhcmVcbiAgICogYmFja2VkIGJ5IGEgc2luZ2xlIHNtYWxsIE5vZGVqc0Z1bmN0aW9uIChpbmdlc3Qvc3JjL2xvZ3NIYW5kbGVyLnRzLCBlbnRyeVxuICAgKiBwb2ludCBgcm91dGVyYCkgZXhwb3NlZCBhcyBvbmUgQXBwU3luYyBMYW1iZGEgZGF0YSBzb3VyY2Ug4oCUIGEgZGlyZWN0XG4gICAqIExhbWJkYSByZXNvbHZlciB3aXRoIG5vIHJlcXVlc3QvcmVzcG9uc2UgbWFwcGluZyB0ZW1wbGF0ZSwgc28gQXBwU3luY1xuICAgKiBwYXNzZXMgdGhlIGVudGlyZSByZXNvbHZlciBjb250ZXh0IChpbmNsdWRpbmcgYGluZm8uZmllbGROYW1lYCkgYW5kIHRoZVxuICAgKiBmdW5jdGlvbiBkaXNwYXRjaGVzIG9uIGl0IChjb25maXJtZWQgYWdhaW5zdCB0aGUgQVdTIEFwcFN5bmNcbiAgICogZGlyZWN0LUxhbWJkYS1yZXNvbHZlciByZWZlcmVuY2UpLiBgZ2V0RXJyb3JFeGNlcnB0YCAoT3B0aW9uIEI6IGV4dHJhY3RcbiAgICogdGhlIGFjdHVhbCBlcnJvciBmcm9tIHRoZSBsb2cgc3RyZWFtIHJhdGhlciB0aGFuIHJlbHlpbmcgb24gSGVhbHRoT21pY3MnXG4gICAqIG9mdGVuLWdlbmVyaWMgYHN0YXR1c01lc3NhZ2VgKSByZXVzZXMgdGhlIHNhbWUgQ2xvdWRXYXRjaCBMb2dzIElBTSBncmFudFxuICAgKiBhcyBgZ2V0UnVuTG9nc2Ag4oCUIG5vIG5ldyBwZXJtaXNzaW9ucyBuZWVkZWQsIHNpbmNlIGl0IHJlYWRzIHRoZSBpZGVudGljYWxcbiAgICogbG9nIGdyb3VwL3N0cmVhbXMuIFRoZSBMYW1iZGEgaXMgZ3JhbnRlZCBSRUFELU9OTFkgYWNjZXNzIHRvIHRoZVxuICAgKiBIZWFsdGhPbWljcyBydW4gbG9nIGdyb3VwIG9ubHkgKG5vIHdpbGRjYXJkcywgUmVxIDExLjIpLCBhbmQgYm90aCBxdWVyaWVzXG4gICAqIGFyZSBDb2duaXRvLWF1dGhvcml6ZWQgbGlrZSB0aGUgb3RoZXIgcmVhZHMuXG4gICAqL1xuICBwcml2YXRlIGFkZExvZ3NSZXNvbHZlcigpOiB2b2lkIHtcbiAgICBjb25zdCBsb2dzRm4gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0xvZ3NGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogTE9HU19IQU5ETEVSX0VOVFJZLFxuICAgICAgaGFuZGxlcjogJ3JvdXRlcicsXG4gICAgICBwcm9qZWN0Um9vdDogSU5HRVNUX1BST0pFQ1RfUk9PVCxcbiAgICAgIGRlcHNMb2NrRmlsZVBhdGg6IElOR0VTVF9ERVBTX0xPQ0tfRklMRSxcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTE9HX0dST1VQX05BTUU6IE9NSUNTX0xPR19HUk9VUCxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogWydAYXdzLXNkay8qJ10sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTGVhc3QtcHJpdmlsZWdlOiByZWFkLW9ubHkgYWNjZXNzIHRvIHRoZSBIZWFsdGhPbWljcyBydW4gbG9nIGdyb3VwIGFuZFxuICAgIC8vIGl0cyBzdHJlYW1zIG9ubHkuIE5vIHdpbGRjYXJkIGFjdGlvbiwgbm8gd2lsZGNhcmQgcmVzb3VyY2UgKFJlcSAxMS4yKS5cbiAgICAvLyBDbG91ZFdhdGNoIGxvZy1ncm91cCBBUk5zIHVzZSBhIENPTE9OIHNlcGFyYXRvciBiZWZvcmUgdGhlIChsZWFkaW5nLXNsYXNoKVxuICAgIC8vIGdyb3VwIG5hbWU6IGFybjphd3M6bG9nczo8cmVnaW9uPjo8YWNjdD46bG9nLWdyb3VwOi9hd3Mvb21pY3MvV29ya2Zsb3dMb2cuXG4gICAgLy8gQnVpbGQgaXQgZXhwbGljaXRseSB0byBhdm9pZCBmb3JtYXRBcm4gaW5zZXJ0aW5nIGEgc2xhc2ggc2VwYXJhdG9yICh3aGljaFxuICAgIC8vIHdvdWxkIHlpZWxkIGFuIGludmFsaWQgYGxvZy1ncm91cC8vYXdzLy4uLmApLiBUaGUgYDoqYCB2YXJpYW50IGNvdmVycyB0aGVcbiAgICAvLyBncm91cCdzIGxvZyBzdHJlYW1zLlxuICAgIGNvbnN0IHsgcmVnaW9uLCBhY2NvdW50IH0gPSBTdGFjay5vZih0aGlzKTtcbiAgICBjb25zdCBsb2dHcm91cEFybiA9IGBhcm46YXdzOmxvZ3M6JHtyZWdpb259OiR7YWNjb3VudH06bG9nLWdyb3VwOiR7T01JQ1NfTE9HX0dST1VQfWA7XG4gICAgbG9nc0ZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICdsb2dzOkdldExvZ0V2ZW50cycsXG4gICAgICAgICAgJ2xvZ3M6RmlsdGVyTG9nRXZlbnRzJyxcbiAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtsb2dHcm91cEFybiwgYCR7bG9nR3JvdXBBcm59OipgXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBjb25zdCBsb2dzRGF0YVNvdXJjZSA9IHRoaXMuYXBpLmFkZExhbWJkYURhdGFTb3VyY2UoXG4gICAgICAnTG9nc0RhdGFTb3VyY2UnLFxuICAgICAgbG9nc0ZuLFxuICAgICk7XG5cbiAgICAvLyBEZWZhdWx0IHJlcXVlc3QvcmVzcG9uc2UgbWFwcGluZyBwYXNzZXMgdGhlIGVudGlyZSByZXNvbHZlciBjb250ZXh0XG4gICAgLy8gdGhyb3VnaCB0byB0aGUgTGFtYmRhIChkaXJlY3QgTGFtYmRhIHJlc29sdmVyKSBhbmQgcmV0dXJucyBpdHMgcmVzdWx0XG4gICAgLy8gYXMtaXMuIE9uZSByZXNvbHZlciBwZXIgZmllbGQsIGJvdGggb24gdGhlIHNhbWUgTGFtYmRhIGRhdGEgc291cmNlOyB0aGVcbiAgICAvLyBMYW1iZGEncyBgcm91dGVyYCBlbnRyeSBwb2ludCBkaXNwYXRjaGVzIG9uIGBpbmZvLmZpZWxkTmFtZWAuXG4gICAgbG9nc0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2dldFJ1bkxvZ3NSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnZ2V0UnVuTG9ncycsXG4gICAgfSk7XG4gICAgbG9nc0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2dldEVycm9yRXhjZXJwdFJlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdnZXRFcnJvckV4Y2VycHQnLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIExhbWJkYS1iYWNrZWQgcmVzb2x2ZXIgZm9yIHRoZSBgZ2V0UnVuTWV0cmljc2AgcXVlcnkuXG4gICAqXG4gICAqIFRoZXJlIGlzIG5vIEFXUyBTREsgb3BlcmF0aW9uIGZvciBDbG91ZFdhdGNoJ3MgUHJvbWV0aGV1cy1jb21wYXRpYmxlXG4gICAqIFByb21RTCBBUEksIHNvIGBnZXRSdW5NZXRyaWNzYCBpcyBiYWNrZWQgYnkgYSBOb2RlanNGdW5jdGlvblxuICAgKiAoaW5nZXN0L3NyYy9tZXRyaWNzSGFuZGxlci50cykgdGhhdCBidWlsZHMgYW5kIFNpZ1Y0LXNpZ25zIGEgcmF3IEhUVFBTXG4gICAqIFBPU1QgaXRzZWxmLCBleHBvc2VkIGFzIGFuIEFwcFN5bmMgTGFtYmRhIGRhdGEgc291cmNlIChtaXJyb3JzXG4gICAqIGBhZGRMb2dzUmVzb2x2ZXJgKS4gVGhlIHF1ZXJ5IGlzIENvZ25pdG8tYXV0aG9yaXplZCBsaWtlIHRoZSBvdGhlciByZWFkcy5cbiAgICpcbiAgICogTGVhc3QtcHJpdmlsZWdlIElBTSwgVkVSSUZJRUQtUkVRVUlSRUQgKGVtcGlyaWNhbGx5IGNvbmZpcm1lZCB2aWEgYSBsaXZlXG4gICAqIHNjb3BlZC1yb2xlIHRlc3QgKyBBV1MgZG9jcyDigJQgc2VlIGRlc2lnbi5tZCBJQU0gc2VjdGlvbik6IHRoZSBDbG91ZFdhdGNoXG4gICAqIFByb21RTCBgUXVlcnlNZXRyaWNzYCBvcGVyYXRpb24gcmVxdWlyZXMgQk9USCBgY2xvdWR3YXRjaDpHZXRNZXRyaWNEYXRhYFxuICAgKiBBTkQgYGNsb3Vkd2F0Y2g6TGlzdE1ldHJpY3NgLiBgUmVzb3VyY2U6ICcqJ2AgaXMgdXNlZCBmb3IgdGhlc2UgdHdvXG4gICAqIGFjdGlvbnMgYmVjYXVzZSB0aGV5IGRvIG5vdCBzdXBwb3J0IHJlc291cmNlLWxldmVsIEFSTiBzY29waW5nIOKAlFxuICAgKiBjb25maXJtZWQgYnkgdGhlIDQwMyBtZXNzYWdlIHJldHVybmVkIGR1cmluZyB2ZXJpZmljYXRpb24sIHdoaWNoIG5hbWVkIGFcbiAgICogZGF0YXNldCBBUk4gQ2xvdWRXYXRjaCBjb250cm9scyBpbnRlcm5hbGx5LCBub3QgYSBjdXN0b21lci1zY29wYWJsZVxuICAgKiByZXNvdXJjZS4gVGhpcyBpcyBhIGRvY3VtZW50ZWQgZXhjZXB0aW9uIHRvIHRoZSBuby13aWxkY2FyZC1yZXNvdXJjZVxuICAgKiBwYXR0ZXJuIHVzZWQgZWxzZXdoZXJlIGluIHRoaXMgc3RhY2ssIGJ1dCBpdCBpcyBOT1QgYSB3aWxkY2FyZCBhY3Rpb25cbiAgICogKG5vIGBBY3Rpb246ICcqJ2ApLlxuICAgKlxuICAgKiBBIHNlcGFyYXRlLCBuYXJyb3cgYG9taWNzOkdldFJ1bmAgZ3JhbnQgc2NvcGVkIHRvIHJ1biBBUk5zIGJhY2tzIHRoZVxuICAgKiB3aW5kb3ctcmVzb2x1dGlvbiBmYWxsYmFjayAoZGVzaWduIFwiUnVuIHdpbmRvd1wiIGRlY2lzaW9uKTogaXQgaXMgdXNlZFxuICAgKiBvbmx5IHdoZW4gdGhlIGNhbGxlciBvbWl0cyBgc3RhcnRUaW1lYC9gZW5kVGltZWAuXG4gICAqL1xuICBwcml2YXRlIGFkZE1ldHJpY3NSZXNvbHZlcigpOiB2b2lkIHtcbiAgICBjb25zdCBtZXRyaWNzRm4gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ01ldHJpY3NGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogTUVUUklDU19IQU5ETEVSX0VOVFJZLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgcHJvamVjdFJvb3Q6IElOR0VTVF9QUk9KRUNUX1JPT1QsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBJTkdFU1RfREVQU19MT0NLX0ZJTEUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIE1FVFJJQ1NfUkVHSU9OOiBTdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICAgIE1PTklUT1JJTkdfSE9TVDogYG1vbml0b3JpbmcuJHtTdGFjay5vZih0aGlzKS5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxuICAgICAgICBTSUdOSU5HX1NFUlZJQ0U6ICdtb25pdG9yaW5nJyxcbiAgICAgIH0sXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBmb3JtYXQ6IE91dHB1dEZvcm1hdC5FU00sXG4gICAgICAgIC8vIEV4dGVybmFsaXplIG9ubHkgdGhlIEFXUyBTREsgbW9kdWxlcyBwcmVzZW50IGluIHRoZSBMYW1iZGEgcnVudGltZS5cbiAgICAgICAgLy8gQHNtaXRoeS9zaWduYXR1cmUtdjQgYW5kIEBhd3MtY3J5cHRvL3NoYTI1Ni1qcyBhcmUgTk9UIGluIHRoZVxuICAgICAgICAvLyBydW50aW1lLCBzbyB0aGV5IGFyZSBidW5kbGVkIChOT1QgZXh0ZXJuYWxpemVkKSDigJQgdGhpcyBpcyB0aGUga2V5XG4gICAgICAgIC8vIGRpZmZlcmVuY2UgZnJvbSBhZGRMb2dzUmVzb2x2ZXIncyBidW5kbGluZy5cbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbJ0Bhd3Mtc2RrLyonXSxcbiAgICAgICAgLy8gQHNtaXRoeS9zaWduYXR1cmUtdjQgYW5kIEBhd3MtY3J5cHRvL3NoYTI1Ni1qcyBhcmUgYXV0aG9yZWQgYXNcbiAgICAgICAgLy8gQ29tbW9uSlMgYW5kIGludGVybmFsbHkgdXNlIGByZXF1aXJlKC4uLilgIChlLmcuIGZvciBOb2RlIGJ1aWx0LWluc1xuICAgICAgICAvLyBsaWtlIFwiYnVmZmVyXCIpLiBCdW5kbGluZyBDSlMgaW50byBhbiBFU00gb3V0cHV0IGxlYXZlcyBubyBgcmVxdWlyZWBcbiAgICAgICAgLy8gaW4gc2NvcGUsIHNvIHRob3NlIGR5bmFtaWMgcmVxdWlyZXMgY3Jhc2ggYXQgcnVudGltZSB3aXRoIFwiRHluYW1pY1xuICAgICAgICAvLyByZXF1aXJlIG9mIC4uLiBpcyBub3Qgc3VwcG9ydGVkXCIgKGNvbmZpcm1lZCB2aWEgQ2xvdWRXYXRjaCBMb2dzKS5cbiAgICAgICAgLy8gSW5qZWN0IHRoZSBzYW1lIGNyZWF0ZVJlcXVpcmUgc2hpbSB1c2VkIGJ5IEluZ2VzdFN0YWNrJ3MgYnVuZGxpbmcgc29cbiAgICAgICAgLy8gdGhlIGJ1bmRsZWQgQ0pTIG1vZHVsZXMgY2FuIHJlc29sdmUgdGhlaXIgcmVxdWlyZXMgdW5kZXIgRVNNLlxuICAgICAgICBiYW5uZXI6XG4gICAgICAgICAgXCJpbXBvcnR7Y3JlYXRlUmVxdWlyZSBhcyBfX2NyZWF0ZVJlcXVpcmV9ZnJvbSdtb2R1bGUnO2NvbnN0IHJlcXVpcmU9X19jcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gTGVhc3QtcHJpdmlsZWdlIElBTSwgVkVSSUZJRUQtUkVRVUlSRUQgKGVtcGlyaWNhbGx5IGNvbmZpcm1lZCB2aWEgYVxuICAgIC8vIGxpdmUgc2NvcGVkLXJvbGUgdGVzdCArIEFXUyBkb2NzIOKAlCBzZWUgZGVzaWduLm1kIElBTSBzZWN0aW9uKTogdGhlXG4gICAgLy8gQ2xvdWRXYXRjaCBQcm9tUUwgUXVlcnlNZXRyaWNzIG9wZXJhdGlvbiByZXF1aXJlcyBCT1RIIGFjdGlvbnMgYmVsb3cuXG4gICAgLy8gUmVzb3VyY2UgJyonIGJlY2F1c2UgdGhlc2UgQ2xvdWRXYXRjaCBtZXRyaWMtZGF0YSBhY3Rpb25zIGRvIG5vdFxuICAgIC8vIHN1cHBvcnQgcmVzb3VyY2UtbGV2ZWwgQVJOIHNjb3BpbmcgKGNvbmZpcm1lZCBieSB0aGUgNDAzIG1lc3NhZ2VcbiAgICAvLyBkdXJpbmcgdmVyaWZpY2F0aW9uLCB3aGljaCBuYW1lZCBhIGRhdGFzZXQgQVJOIENsb3VkV2F0Y2ggY29udHJvbHNcbiAgICAvLyBpbnRlcm5hbGx5LCBub3QgYSBjdXN0b21lci1zY29wYWJsZSByZXNvdXJjZSkuIE5vIEFjdGlvbjogJyonLlxuICAgIG1ldHJpY3NGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnY2xvdWR3YXRjaDpHZXRNZXRyaWNEYXRhJywgJ2Nsb3Vkd2F0Y2g6TGlzdE1ldHJpY3MnXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICAvLyBOYXJyb3csIHJ1bi1BUk4tc2NvcGVkIGZhbGxiYWNrIHBlcm1pc3Npb24gZm9yIHRoZSB3aW5kb3ctcmVzb2x1dGlvblxuICAgIC8vIEdldFJ1biBjYWxsIChkZXNpZ24gXCJSdW4gd2luZG93XCIgZGVjaXNpb24pIOKAlCBvbmx5IHVzZWQgd2hlbiB0aGVcbiAgICAvLyBjYWxsZXIgb21pdHMgc3RhcnRUaW1lL2VuZFRpbWUuXG4gICAgY29uc3QgeyByZWdpb24sIGFjY291bnQgfSA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIG1ldHJpY3NGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnb21pY3M6R2V0UnVuJ10sXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOm9taWNzOiR7cmVnaW9ufToke2FjY291bnR9OnJ1bi8qYF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgY29uc3QgbWV0cmljc0RhdGFTb3VyY2UgPSB0aGlzLmFwaS5hZGRMYW1iZGFEYXRhU291cmNlKFxuICAgICAgJ01ldHJpY3NEYXRhU291cmNlJyxcbiAgICAgIG1ldHJpY3NGbixcbiAgICApO1xuXG4gICAgbWV0cmljc0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2dldFJ1bk1ldHJpY3NSZXNvbHZlcicsIHtcbiAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgZmllbGROYW1lOiAnZ2V0UnVuTWV0cmljcycsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogU3RhY2sgb3V0cHV0cyBjb25zdW1lZCBieSB0aGUgZnJvbnRlbmQgYnVpbGQgKHRhc2sgMTIuMSkuXG4gICAqXG4gICAqIFRoZSBBcHBTeW5jIEdyYXBoUUwgZW5kcG9pbnQgVVJMLCBDb2duaXRvIHVzZXIgcG9vbCBJRCwgYXBwIGNsaWVudCBJRCwgYW5kXG4gICAqIHJlZ2lvbiBhcmUgZW1pdHRlZCB3aXRoIGV4cG9ydCBuYW1lcyBzbyB0aGUgVml0ZSBidWlsZCBjYW4gaW5qZWN0IHRoZW0gYXRcbiAgICogYnVpbGQgdGltZSBhbmQgdGhlIFNQQSBjYXJyaWVzIG5vIGhhcmRjb2RlZCBlbnZpcm9ubWVudCB2YWx1ZXMgKFJlcSAxMS43KS5cbiAgICovXG4gIHByaXZhdGUgYWRkT3V0cHV0cygpOiB2b2lkIHtcbiAgICBjb25zdCBvdXRwdXRzOiBSZWFkb25seUFycmF5PHtcbiAgICAgIGlkOiBzdHJpbmc7XG4gICAgICB2YWx1ZTogc3RyaW5nO1xuICAgICAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgICB9PiA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdHcmFwaHFsQXBpVXJsJyxcbiAgICAgICAgdmFsdWU6IHRoaXMuYXBpLmdyYXBocWxVcmwsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQXBwU3luYyBHcmFwaFFMIGVuZHBvaW50IFVSTC4nLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdVc2VyUG9vbElkJyxcbiAgICAgICAgdmFsdWU6IHRoaXMudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIHVzZXIgcG9vbCBJRC4nLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6ICdVc2VyUG9vbENsaWVudElkJyxcbiAgICAgICAgdmFsdWU6IHRoaXMudXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgICAgZGVzY3JpcHRpb246ICdDb2duaXRvIGFwcCBjbGllbnQgSUQgZm9yIHRoZSBTUEEuJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnUmVnaW9uJyxcbiAgICAgICAgdmFsdWU6IHRoaXMucmVnaW9uLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FXUyByZWdpb24gdGhlIEFQSSBpcyBkZXBsb3llZCBpbi4nLFxuICAgICAgfSxcbiAgICBdO1xuXG4gICAgZm9yIChjb25zdCB7IGlkLCB2YWx1ZSwgZGVzY3JpcHRpb24gfSBvZiBvdXRwdXRzKSB7XG4gICAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsIGlkLCB7XG4gICAgICAgIHZhbHVlLFxuICAgICAgICBkZXNjcmlwdGlvbixcbiAgICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LSR7aWR9YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBBUFBTWU5DX0pTIHJlYWQgcmVzb2x2ZXJzIG9uIHRoZSBEeW5hbW9EQiBkYXRhIHNvdXJjZS5cbiAgICpcbiAgICogLSBsaXN0UnVuczogUXVlcnkgR1NJMSAoR1NJMVBLID0gJ1JVTlMnKSBkZXNjZW5kaW5nIGJ5IHVwZGF0ZWRBdCB3aXRoXG4gICAqICAgc2VydmVyLXNpZGUgbGltaXQgdmFsaWRhdGlvbiAoMeKAkzEwMCwgZGVmYXVsdCAyNSkgYW5kIG5leHRUb2tlblxuICAgKiAgIHBhZ2luYXRpb247IG91dC1vZi1yYW5nZSBsaW1pdHMgYW5kIG1hbGZvcm1lZC9leHBpcmVkIHRva2VucyBhcmUgcmVqZWN0ZWRcbiAgICogICAoUmVxIDUuMiwgNS4zLCA1LjQsIDUuNSkuXG4gICAqIC0gZ2V0UnVuOiBHZXRJdGVtIFBLID0gU0sgPSAnUlVOIzxydW5JZD4nOyBudWxsIChubyBlcnJvcikgd2hlbiBhYnNlbnRcbiAgICogICAoUmVxIDUuNiwgNS43KS5cbiAgICogLSBsaXN0VGFza3NGb3JSdW46IFF1ZXJ5IFBLID0gJ1JVTiM8cnVuSWQ+JywgU0sgYmVnaW5zX3dpdGggJ1RBU0sjJztcbiAgICogICByZXR1cm5zIGl0ZW1zIG9yIGFuIGVtcHR5IGxpc3QgKFJlcSA1LjgpLlxuICAgKiAtIGdldFN0YXRpY0dyYXBoOiBHZXRJdGVtIFBLID0gU0sgPSAnV0YjPHdvcmtmbG93SWQ+Izx3b3JrZmxvd1ZlcnNpb25OYW1lPic7XG4gICAqICAgbnVsbCAobm8gZXJyb3IpIHdoZW4gYWJzZW50IG9yIGEgZmFpbHVyZS1vbmx5IG1hcmtlciAoUmVxIDYuNikuIEdldEl0ZW1cbiAgICogICBvbmx5LCB3aXRoaW4gdGhlIGV4aXN0aW5nIHJlYWQtb25seSBncmFudCDigJQgbm8gbmV3IGRhdGEgc291cmNlL0lBTS5cbiAgICovXG4gIHByaXZhdGUgYWRkUmVhZFJlc29sdmVycyhkYXRhU291cmNlOiBEeW5hbW9EYkRhdGFTb3VyY2UpOiB2b2lkIHtcbiAgICBjb25zdCByZWFkczogUmVhZG9ubHlBcnJheTx7IGZpZWxkOiBzdHJpbmc7IGZpbGU6IHN0cmluZyB9PiA9IFtcbiAgICAgIHsgZmllbGQ6ICdsaXN0UnVucycsIGZpbGU6ICdsaXN0UnVucy5qcycgfSxcbiAgICAgIHsgZmllbGQ6ICdnZXRSdW4nLCBmaWxlOiAnZ2V0UnVuLmpzJyB9LFxuICAgICAgeyBmaWVsZDogJ2xpc3RUYXNrc0ZvclJ1bicsIGZpbGU6ICdsaXN0VGFza3NGb3JSdW4uanMnIH0sXG4gICAgICB7IGZpZWxkOiAnZ2V0U3RhdGljR3JhcGgnLCBmaWxlOiAnZ2V0U3RhdGljR3JhcGguanMnIH0sXG4gICAgXTtcblxuICAgIGZvciAoY29uc3QgeyBmaWVsZCwgZmlsZSB9IG9mIHJlYWRzKSB7XG4gICAgICBuZXcgUmVzb2x2ZXIodGhpcywgYCR7ZmllbGR9UmVzb2x2ZXJgLCB7XG4gICAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICAgIHR5cGVOYW1lOiAnUXVlcnknLFxuICAgICAgICBmaWVsZE5hbWU6IGZpZWxkLFxuICAgICAgICBkYXRhU291cmNlLFxuICAgICAgICBydW50aW1lOiBGdW5jdGlvblJ1bnRpbWUuSlNfMV8wXzAsXG4gICAgICAgIGNvZGU6IENvZGUuZnJvbUFzc2V0KHJlc29sdmVyUGF0aChmaWxlKSksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUGFzcy10aHJvdWdoIHJlc29sdmVycyBmb3IgdGhlIElBTS1hdXRob3JpemVkIHB1Ymxpc2ggbXV0YXRpb25zLlxuICAgKlxuICAgKiBwdWJsaXNoUnVuVXBkYXRlIC8gcHVibGlzaFRhc2tVcGRhdGUgY2Fycnkgbm8gZGF0YS1zb3VyY2Ugd29yazogdGhleSBlY2hvXG4gICAqIHRoZWlyIGlucHV0IG9uIGEgTk9ORSAobG9jYWwpIGRhdGEgc291cmNlIHNvIEBhd3Nfc3Vic2NyaWJlIGZhbnMgdGhlXG4gICAqIHBheWxvYWQgb3V0IHRvIG9uUnVuVXBkYXRlZCAvIG9uVGFza1VwZGF0ZWQgc3Vic2NyaWJlcnMgKFJlcSA0LjUsIDQuNikuIFRoZVxuICAgKiBpbmdlc3QgTGFtYmRhIGhhcyBhbHJlYWR5IHBlcnNpc3RlZCB0aGUgcnVuL3Rhc2sgYmVmb3JlIGNhbGxpbmcgdGhlbS5cbiAgICovXG4gIHByaXZhdGUgYWRkUHVibGlzaFJlc29sdmVycygpOiB2b2lkIHtcbiAgICBjb25zdCBub25lRGF0YVNvdXJjZSA9IHRoaXMuYXBpLmFkZE5vbmVEYXRhU291cmNlKCdQdWJsaXNoTm9uZURhdGFTb3VyY2UnKTtcblxuICAgIGZvciAoY29uc3QgZmllbGQgb2YgWydwdWJsaXNoUnVuVXBkYXRlJywgJ3B1Ymxpc2hUYXNrVXBkYXRlJ10pIHtcbiAgICAgIG5ldyBSZXNvbHZlcih0aGlzLCBgJHtmaWVsZH1SZXNvbHZlcmAsIHtcbiAgICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgICAgdHlwZU5hbWU6ICdNdXRhdGlvbicsXG4gICAgICAgIGZpZWxkTmFtZTogZmllbGQsXG4gICAgICAgIGRhdGFTb3VyY2U6IG5vbmVEYXRhU291cmNlLFxuICAgICAgICBydW50aW1lOiBGdW5jdGlvblJ1bnRpbWUuSlNfMV8wXzAsXG4gICAgICAgIGNvZGU6IENvZGUuZnJvbUFzc2V0KHJlc29sdmVyUGF0aCgncHVibGlzaFBhc3N0aHJvdWdoLmpzJykpLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG4iXX0=