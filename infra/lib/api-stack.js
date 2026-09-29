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
        //
        // Security hardening (security audit remediation):
        //   - selfSignUpEnabled:false — no open registration; users are
        //     admin-provisioned only.
        //   - passwordPolicy — an EXPLICIT strong policy (not the inherited Cognito
        //     default): min length 12, all four character classes required, temp
        //     passwords expire in 1 day, and (PLUS feature) a password history of 3
        //     so a reset cannot reuse the last 3 passwords.
        //   - featurePlan:PLUS + standardThreatProtectionMode:FULL_FUNCTION —
        //     Cognito threat protection (advanced security). This is the
        //     brute-force / credential-stuffing defense: FULL_FUNCTION ENFORCES
        //     adaptive/risk-based responses (blocks sign-ins from risky sources,
        //     detects compromised credentials) rather than only auditing. Carries a
        //     per-MAU cost, acceptable for the small admin user base.
        this.userPool = new aws_cognito_1.UserPool(this, 'UserPool', {
            selfSignUpEnabled: false,
            signInAliases: { email: true },
            standardAttributes: {
                email: { required: true, mutable: true },
            },
            accountRecovery: aws_cognito_1.AccountRecovery.EMAIL_ONLY,
            // Explicit strong password policy (owned + auditable, not the default).
            passwordPolicy: {
                minLength: 12,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: true,
                // Disallow reusing any of the last 3 passwords (requires FeaturePlan.PLUS).
                passwordHistorySize: 3,
                // Admin-issued temporary passwords must be changed within 1 day.
                tempPasswordValidity: aws_cdk_lib_1.Duration.days(1),
            },
            // Brute-force / credential-stuffing protection: enable the PLUS feature
            // plan and ENFORCE threat protection (adaptive auth + compromised-
            // credential detection), not merely audit it.
            featurePlan: aws_cognito_1.FeaturePlan.PLUS,
            standardThreatProtectionMode: aws_cognito_1.StandardThreatProtectionMode.FULL_FUNCTION,
        });
        this.userPoolClient = this.userPool.addClient('SpaClient', {
            // SRP only — never enable USER_PASSWORD_AUTH (plaintext password flow) or
            // admin auth flows for the public SPA client.
            authFlows: { userSrp: true },
            // Do not reveal whether a username exists on failed sign-in / forgot-
            // password (defends account enumeration, complements threat protection).
            preventUserExistenceErrors: true,
            // Bound token lifetimes (defense-in-depth: shorter windows for a stolen
            // access/id token; refresh token capped so a lost device loses access).
            accessTokenValidity: aws_cdk_lib_1.Duration.hours(1),
            idTokenValidity: aws_cdk_lib_1.Duration.hours(1),
            refreshTokenValidity: aws_cdk_lib_1.Duration.days(30),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBpLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDJDQUE2QjtBQUM3Qiw2Q0FBcUU7QUFDckUseURBUWlDO0FBQ2pDLHlEQU1pQztBQUNqQyx1REFBaUQ7QUFDakQscUVBQTZFO0FBQzdFLGlEQUE4RDtBQUk5RCxnRkFBZ0Y7QUFDaEYsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ3ZFLE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUNuRixNQUFNLHFCQUFxQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEVBQUUsS0FBSyxFQUFFLG1CQUFtQixDQUFDLENBQUM7QUFDekYsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixFQUFFLEtBQUssRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0FBQ25GLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLEVBQUUsbUJBQW1CLENBQUMsQ0FBQztBQUN6RixNQUFNLHFCQUFxQixHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEVBQUUsbUJBQW1CLENBQUMsQ0FBQztBQUVsRixvRUFBb0U7QUFDcEUsTUFBTSxlQUFlLEdBQUcsd0JBQXdCLENBQUM7QUFPakQsaUZBQWlGO0FBQ2pGLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztBQUU1RSxpRUFBaUU7QUFDakUsTUFBTSxh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akMsSUFBSSxFQUFFLGtCQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO2FBQzVELENBQUMsQ0FBQztRQUNMLENBQUM7SUFDSCxDQUFDO0NBQ0Y7QUF0akJELDRCQXNqQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgQ2ZuT3V0cHV0LCBEdXJhdGlvbiwgU3RhY2ssIFN0YWNrUHJvcHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQge1xuICBBdXRob3JpemF0aW9uVHlwZSxcbiAgQ29kZSxcbiAgRGVmaW5pdGlvbixcbiAgRHluYW1vRGJEYXRhU291cmNlLFxuICBGdW5jdGlvblJ1bnRpbWUsXG4gIEdyYXBocWxBcGksXG4gIFJlc29sdmVyLFxufSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXBwc3luYyc7XG5pbXBvcnQge1xuICBBY2NvdW50UmVjb3ZlcnksXG4gIEZlYXR1cmVQbGFuLFxuICBTdGFuZGFyZFRocmVhdFByb3RlY3Rpb25Nb2RlLFxuICBVc2VyUG9vbCxcbiAgVXNlclBvb2xDbGllbnQsXG59IGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCB7IFJ1bnRpbWUgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uLCBPdXRwdXRGb3JtYXQgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgeyBFZmZlY3QsIFBvbGljeVN0YXRlbWVudCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgeyBEYXRhU3RhY2sgfSBmcm9tICcuL2RhdGEtc3RhY2snO1xuXG4vKiogVGhlIGluZ2VzdCBwYWNrYWdlIGRpciAoc2libGluZyBvZiBpbmZyYS8pLCB3aGVyZSB0aGUgbG9ncyBoYW5kbGVyIGxpdmVzLiAqL1xuY29uc3QgSU5HRVNUX1BST0pFQ1RfUk9PVCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICcuLicsICdpbmdlc3QnKTtcbmNvbnN0IExPR1NfSEFORExFUl9FTlRSWSA9IHBhdGguam9pbihJTkdFU1RfUFJPSkVDVF9ST09ULCAnc3JjJywgJ2xvZ3NIYW5kbGVyLnRzJyk7XG5jb25zdCBNRVRSSUNTX0hBTkRMRVJfRU5UUlkgPSBwYXRoLmpvaW4oSU5HRVNUX1BST0pFQ1RfUk9PVCwgJ3NyYycsICdtZXRyaWNzSGFuZGxlci50cycpO1xuY29uc3QgQ09TVF9IQU5ETEVSX0VOVFJZID0gcGF0aC5qb2luKElOR0VTVF9QUk9KRUNUX1JPT1QsICdzcmMnLCAnY29zdEhhbmRsZXIudHMnKTtcbmNvbnN0IFJFUE9SVFNfSEFORExFUl9FTlRSWSA9IHBhdGguam9pbihJTkdFU1RfUFJPSkVDVF9ST09ULCAnc3JjJywgJ3JlcG9ydHNIYW5kbGVyLnRzJyk7XG5jb25zdCBJTkdFU1RfREVQU19MT0NLX0ZJTEUgPSBwYXRoLmpvaW4oSU5HRVNUX1BST0pFQ1RfUk9PVCwgJ3BhY2thZ2UtbG9jay5qc29uJyk7XG5cbi8qKiBIZWFsdGhPbWljcyB3cml0ZXMgYWxsIHJ1biBsb2dzIHRvIHRoaXMgQ2xvdWRXYXRjaCBsb2cgZ3JvdXAuICovXG5jb25zdCBPTUlDU19MT0dfR1JPVVAgPSAnL2F3cy9vbWljcy9Xb3JrZmxvd0xvZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBpU3RhY2tQcm9wcyBleHRlbmRzIFN0YWNrUHJvcHMge1xuICAvKiogVGhlIGRhdGEgbGF5ZXIgdGhpcyBBUEkgcmVhZHMgZnJvbS4gRXN0YWJsaXNoZXMgZGVwbG95IG9yZGVyaW5nLiAqL1xuICByZWFkb25seSBkYXRhU3RhY2s6IERhdGFTdGFjaztcbn1cblxuLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIEdyYXBoUUwgc2NoZW1hIChyZXNvbHZlcyB1bmRlciBib3RoIHRzLW5vZGUgYW5kIHRzYykuICovXG5jb25zdCBTQ0hFTUFfUEFUSCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdncmFwaHFsJywgJ3NjaGVtYS5ncmFwaHFsJyk7XG5cbi8qKiBBYnNvbHV0ZSBwYXRoIHRvIHRoZSBBUFBTWU5DX0pTIHJlc29sdmVyIGFzc2V0cyBkaXJlY3RvcnkuICovXG5jb25zdCBSRVNPTFZFUlNfRElSID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ3Jlc29sdmVycycpO1xuXG4vKiogQWJzb2x1dGUgcGF0aCB0byBhIHNpbmdsZSBuYW1lZCByZXNvbHZlciBhc3NldC4gKi9cbmZ1bmN0aW9uIHJlc29sdmVyUGF0aChuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcGF0aC5qb2luKFJFU09MVkVSU19ESVIsIG5hbWUpO1xufVxuXG4vKipcbiAqIEFwaVN0YWNrIOKAlCB0aGUgQVBJIGxheWVyLlxuICpcbiAqIE93bnMgdGhlIEFwcFN5bmMgR3JhcGhRTCBBUEkgKHNjaGVtYSwgSlMgcmVzb2x2ZXJzIG9uIER5bmFtb0RCLCBvcHRpb25hbFxuICogTGFtYmRhIGRhdGEgc291cmNlKSwgdGhlIENvZ25pdG8gdXNlciBwb29sICsgYXBwIGNsaWVudCwgYW5kIGF1dGhvcml6YXRpb25cbiAqIChkZWZhdWx0IENvZ25pdG8gdXNlciBwb29sLCBJQU0gZm9yIHRoZSBpbmdlc3QgcHVibGlzaCBtdXRhdGlvbnMpLlxuICpcbiAqIFRoZSBDb2duaXRvIHVzZXIgcG9vbCBhbmQgYXBwIGNsaWVudCBhcmUgY3JlYXRlZCBCRUZPUkUgdGhlIEFQSSBzb1xuICogYXV0aG9yaXphdGlvbiBjYW4gbmV2ZXIgYmUgd2lyZWQgYmVmb3JlIHRoZSBwb29sIGV4aXN0cyAoUmVxIDExLjEwKS4gVGhlIEFQSVxuICogZGVmYXVsdCBhdXRob3JpemF0aW9uIG1vZGUgaXMgdGhlIENvZ25pdG8gdXNlciBwb29sIChSZXEgNS4xMiwgMTEuNikgd2l0aCBJQU1cbiAqIGFzIGFuIGFkZGl0aW9uYWwgbW9kZSBzbyB0aGUgaW5nZXN0IExhbWJkYSBjYW4gaW52b2tlIHRoZSBJQU0tYXV0aG9yaXplZFxuICogcHVibGlzaCBtdXRhdGlvbnMgKFJlcSA0LjMsIDQuNCkuXG4gKlxuICogQVBQU1lOQ19KUyAoSlMgcnVudGltZSkgcmVzb2x2ZXJzIGJhY2sgdGhlIHJlYWQgcXVlcmllcyBkaXJlY3RseSBvbiBhXG4gKiBEeW5hbW9EQiBkYXRhIHNvdXJjZSAoUmVxIDUuMTEpOiBsaXN0UnVucyAoR1NJMSBkZXNjZW5kaW5nLCBzZXJ2ZXItc2lkZSBsaW1pdFxuICogdmFsaWRhdGlvbiwgbmV4dFRva2VuIHBhZ2luYXRpb24g4oCUIFJlcSA1LjLigJM1LjUpLCBnZXRSdW4gKEdldEl0ZW0sIG51bGwgd2hlblxuICogYWJzZW50IOKAlCBSZXEgNS42LCA1LjcpLCBhbmQgbGlzdFRhc2tzRm9yUnVuIChRdWVyeSBieSBydW4g4oCUIFJlcSA1LjgpLiBUaGVcbiAqIHB1Ymxpc2ggbXV0YXRpb25zIGFyZSBwYXNzLXRocm91Z2ggcmVzb2x2ZXJzIG9uIGEgTk9ORSBkYXRhIHNvdXJjZSB0aGF0IGVjaG9cbiAqIHRoZWlyIGlucHV0IHNvIEBhd3Nfc3Vic2NyaWJlIGZhbnMgb3V0IHRvIG9uUnVuVXBkYXRlZCAvIG9uVGFza1VwZGF0ZWRcbiAqIChSZXEgNC41LCA0LjYpLlxuICpcbiAqIFRoZSBEeW5hbW9EQiBkYXRhIHNvdXJjZSBpcyBwcm92aXNpb25lZCBSRUFELU9OTFkgKGByZWFkT25seUFjY2VzczogdHJ1ZWApXG4gKiBzbyBpdHMgc2VydmljZSByb2xlIGNhbiBvbmx5IHJlYWQgdGhlIHRhYmxlL0dTSSBmb3IgdGhlIHF1ZXJ5IHJlc29sdmVycyBhbmRcbiAqIG5ldmVyIHdyaXRlIOKAlCBkZWxpYmVyYXRlbHkgbmFycm93ZXIgdGhhbiBDREsncyBkZWZhdWx0XG4gKiBgYWRkRHluYW1vRGJEYXRhU291cmNlYCwgd2hpY2ggZ3JhbnRzIHJlYWQrd3JpdGUuIFRoZSBncmFudCBjYXJyaWVzIG5vXG4gKiBgQWN0aW9uOiBcIipcImAgYW5kIG5vIGBSZXNvdXJjZTogXCIqXCJgIChSZXEgMTEuMikuXG4gKlxuICogVGhlIEFwcFN5bmMgZW5kcG9pbnQgVVJMLCBDb2duaXRvIHVzZXIgcG9vbCBJRCwgYXBwIGNsaWVudCBJRCwgYW5kIHJlZ2lvbiBhcmVcbiAqIGVtaXR0ZWQgYXMgc3RhY2sgb3V0cHV0cyAod2l0aCBleHBvcnQgbmFtZXMpIHNvIHRoZSBmcm9udGVuZCBidWlsZCBjYW4gaW5qZWN0XG4gKiB0aGVtIGF0IGJ1aWxkIHRpbWUgKFJlcSAxMS43LCB0YXNrIDEyLjEpLlxuICpcbiAqIFJlcXVpcmVtZW50czogNS4xLCA1LjIsIDUuMywgNS40LCA1LjUsIDUuNiwgNS43LCA1LjgsIDUuOSwgNS4xMCwgNS4xMSwgNS4xMixcbiAqIDUuMTMsIDQuNSwgNC42LCAxMS4yLCAxMS42LCAxMS43LCAxMS4xMC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwaVN0YWNrIGV4dGVuZHMgU3RhY2sge1xuICAvKiogVGhlIEFwcFN5bmMgR3JhcGhRTCBBUEkuICovXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IEdyYXBocWxBcGk7XG5cbiAgLyoqIFRoZSBDb2duaXRvIHVzZXIgcG9vbCBndWFyZGluZyBpbnRlcmFjdGl2ZSBhY2Nlc3MgdG8gdGhlIEFQSS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sOiBVc2VyUG9vbDtcblxuICAvKiogVGhlIENvZ25pdG8gYXBwIGNsaWVudCB0aGUgU1BBIGF1dGhlbnRpY2F0ZXMgYWdhaW5zdC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sQ2xpZW50OiBVc2VyUG9vbENsaWVudDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBpU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gUHJvdmlzaW9uIHRoZSBDb2duaXRvIHVzZXIgcG9vbCArIGFwcCBjbGllbnQgRklSU1QsIGJlZm9yZSB0aGUgQVBJJ3NcbiAgICAvLyBhdXRob3JpemF0aW9uIGlzIGNvbmZpZ3VyZWQsIHNvIHRoZSBwb29sIGFsd2F5cyBleGlzdHMgYmVmb3JlIGl0IGlzXG4gICAgLy8gcmVmZXJlbmNlZCAoUmVxIDExLjEwKS5cbiAgICAvL1xuICAgIC8vIFNlY3VyaXR5IGhhcmRlbmluZyAoc2VjdXJpdHkgYXVkaXQgcmVtZWRpYXRpb24pOlxuICAgIC8vICAgLSBzZWxmU2lnblVwRW5hYmxlZDpmYWxzZSDigJQgbm8gb3BlbiByZWdpc3RyYXRpb247IHVzZXJzIGFyZVxuICAgIC8vICAgICBhZG1pbi1wcm92aXNpb25lZCBvbmx5LlxuICAgIC8vICAgLSBwYXNzd29yZFBvbGljeSDigJQgYW4gRVhQTElDSVQgc3Ryb25nIHBvbGljeSAobm90IHRoZSBpbmhlcml0ZWQgQ29nbml0b1xuICAgIC8vICAgICBkZWZhdWx0KTogbWluIGxlbmd0aCAxMiwgYWxsIGZvdXIgY2hhcmFjdGVyIGNsYXNzZXMgcmVxdWlyZWQsIHRlbXBcbiAgICAvLyAgICAgcGFzc3dvcmRzIGV4cGlyZSBpbiAxIGRheSwgYW5kIChQTFVTIGZlYXR1cmUpIGEgcGFzc3dvcmQgaGlzdG9yeSBvZiAzXG4gICAgLy8gICAgIHNvIGEgcmVzZXQgY2Fubm90IHJldXNlIHRoZSBsYXN0IDMgcGFzc3dvcmRzLlxuICAgIC8vICAgLSBmZWF0dXJlUGxhbjpQTFVTICsgc3RhbmRhcmRUaHJlYXRQcm90ZWN0aW9uTW9kZTpGVUxMX0ZVTkNUSU9OIOKAlFxuICAgIC8vICAgICBDb2duaXRvIHRocmVhdCBwcm90ZWN0aW9uIChhZHZhbmNlZCBzZWN1cml0eSkuIFRoaXMgaXMgdGhlXG4gICAgLy8gICAgIGJydXRlLWZvcmNlIC8gY3JlZGVudGlhbC1zdHVmZmluZyBkZWZlbnNlOiBGVUxMX0ZVTkNUSU9OIEVORk9SQ0VTXG4gICAgLy8gICAgIGFkYXB0aXZlL3Jpc2stYmFzZWQgcmVzcG9uc2VzIChibG9ja3Mgc2lnbi1pbnMgZnJvbSByaXNreSBzb3VyY2VzLFxuICAgIC8vICAgICBkZXRlY3RzIGNvbXByb21pc2VkIGNyZWRlbnRpYWxzKSByYXRoZXIgdGhhbiBvbmx5IGF1ZGl0aW5nLiBDYXJyaWVzIGFcbiAgICAvLyAgICAgcGVyLU1BVSBjb3N0LCBhY2NlcHRhYmxlIGZvciB0aGUgc21hbGwgYWRtaW4gdXNlciBiYXNlLlxuICAgIHRoaXMudXNlclBvb2wgPSBuZXcgVXNlclBvb2wodGhpcywgJ1VzZXJQb29sJywge1xuICAgICAgc2VsZlNpZ25VcEVuYWJsZWQ6IGZhbHNlLFxuICAgICAgc2lnbkluQWxpYXNlczogeyBlbWFpbDogdHJ1ZSB9LFxuICAgICAgc3RhbmRhcmRBdHRyaWJ1dGVzOiB7XG4gICAgICAgIGVtYWlsOiB7IHJlcXVpcmVkOiB0cnVlLCBtdXRhYmxlOiB0cnVlIH0sXG4gICAgICB9LFxuICAgICAgYWNjb3VudFJlY292ZXJ5OiBBY2NvdW50UmVjb3ZlcnkuRU1BSUxfT05MWSxcbiAgICAgIC8vIEV4cGxpY2l0IHN0cm9uZyBwYXNzd29yZCBwb2xpY3kgKG93bmVkICsgYXVkaXRhYmxlLCBub3QgdGhlIGRlZmF1bHQpLlxuICAgICAgcGFzc3dvcmRQb2xpY3k6IHtcbiAgICAgICAgbWluTGVuZ3RoOiAxMixcbiAgICAgICAgcmVxdWlyZUxvd2VyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVVwcGVyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZURpZ2l0czogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVN5bWJvbHM6IHRydWUsXG4gICAgICAgIC8vIERpc2FsbG93IHJldXNpbmcgYW55IG9mIHRoZSBsYXN0IDMgcGFzc3dvcmRzIChyZXF1aXJlcyBGZWF0dXJlUGxhbi5QTFVTKS5cbiAgICAgICAgcGFzc3dvcmRIaXN0b3J5U2l6ZTogMyxcbiAgICAgICAgLy8gQWRtaW4taXNzdWVkIHRlbXBvcmFyeSBwYXNzd29yZHMgbXVzdCBiZSBjaGFuZ2VkIHdpdGhpbiAxIGRheS5cbiAgICAgICAgdGVtcFBhc3N3b3JkVmFsaWRpdHk6IER1cmF0aW9uLmRheXMoMSksXG4gICAgICB9LFxuICAgICAgLy8gQnJ1dGUtZm9yY2UgLyBjcmVkZW50aWFsLXN0dWZmaW5nIHByb3RlY3Rpb246IGVuYWJsZSB0aGUgUExVUyBmZWF0dXJlXG4gICAgICAvLyBwbGFuIGFuZCBFTkZPUkNFIHRocmVhdCBwcm90ZWN0aW9uIChhZGFwdGl2ZSBhdXRoICsgY29tcHJvbWlzZWQtXG4gICAgICAvLyBjcmVkZW50aWFsIGRldGVjdGlvbiksIG5vdCBtZXJlbHkgYXVkaXQgaXQuXG4gICAgICBmZWF0dXJlUGxhbjogRmVhdHVyZVBsYW4uUExVUyxcbiAgICAgIHN0YW5kYXJkVGhyZWF0UHJvdGVjdGlvbk1vZGU6IFN0YW5kYXJkVGhyZWF0UHJvdGVjdGlvbk1vZGUuRlVMTF9GVU5DVElPTixcbiAgICB9KTtcblxuICAgIHRoaXMudXNlclBvb2xDbGllbnQgPSB0aGlzLnVzZXJQb29sLmFkZENsaWVudCgnU3BhQ2xpZW50Jywge1xuICAgICAgLy8gU1JQIG9ubHkg4oCUIG5ldmVyIGVuYWJsZSBVU0VSX1BBU1NXT1JEX0FVVEggKHBsYWludGV4dCBwYXNzd29yZCBmbG93KSBvclxuICAgICAgLy8gYWRtaW4gYXV0aCBmbG93cyBmb3IgdGhlIHB1YmxpYyBTUEEgY2xpZW50LlxuICAgICAgYXV0aEZsb3dzOiB7IHVzZXJTcnA6IHRydWUgfSxcbiAgICAgIC8vIERvIG5vdCByZXZlYWwgd2hldGhlciBhIHVzZXJuYW1lIGV4aXN0cyBvbiBmYWlsZWQgc2lnbi1pbiAvIGZvcmdvdC1cbiAgICAgIC8vIHBhc3N3b3JkIChkZWZlbmRzIGFjY291bnQgZW51bWVyYXRpb24sIGNvbXBsZW1lbnRzIHRocmVhdCBwcm90ZWN0aW9uKS5cbiAgICAgIHByZXZlbnRVc2VyRXhpc3RlbmNlRXJyb3JzOiB0cnVlLFxuICAgICAgLy8gQm91bmQgdG9rZW4gbGlmZXRpbWVzIChkZWZlbnNlLWluLWRlcHRoOiBzaG9ydGVyIHdpbmRvd3MgZm9yIGEgc3RvbGVuXG4gICAgICAvLyBhY2Nlc3MvaWQgdG9rZW47IHJlZnJlc2ggdG9rZW4gY2FwcGVkIHNvIGEgbG9zdCBkZXZpY2UgbG9zZXMgYWNjZXNzKS5cbiAgICAgIGFjY2Vzc1Rva2VuVmFsaWRpdHk6IER1cmF0aW9uLmhvdXJzKDEpLFxuICAgICAgaWRUb2tlblZhbGlkaXR5OiBEdXJhdGlvbi5ob3VycygxKSxcbiAgICAgIHJlZnJlc2hUb2tlblZhbGlkaXR5OiBEdXJhdGlvbi5kYXlzKDMwKSxcbiAgICB9KTtcblxuICAgIC8vIEFwcFN5bmMgR3JhcGhRTCBBUEkuIERlZmF1bHQgYXV0aG9yaXphdGlvbiBpcyB0aGUgQ29nbml0byB1c2VyIHBvb2wgc29cbiAgICAvLyBpbnRlcmFjdGl2ZSBxdWVyaWVzIGFuZCBzdWJzY3JpcHRpb25zIHJlcXVpcmUgYSB2YWxpZCBwb29sLWlzc3VlZCB0b2tlblxuICAgIC8vIChSZXEgNS4xMiwgMTEuNik7IHJlcXVlc3RzIHdpdGhvdXQgdmFsaWQgY3JlZGVudGlhbHMgYXJlIHJlamVjdGVkIHdpdGhvdXRcbiAgICAvLyByZXR1cm5pbmcgZGF0YSAoUmVxIDUuMTMpLiBJQU0gaXMgYWRkZWQgYXMgYW4gYWRkaXRpb25hbCBhdXRob3JpemF0aW9uXG4gICAgLy8gbW9kZSBzbyBvbmx5IHRoZSBpbmdlc3QgTGFtYmRhJ3Mgcm9sZSBjYW4gY2FsbCB0aGUgSUFNLWF1dGhvcml6ZWQgcHVibGlzaFxuICAgIC8vIG11dGF0aW9ucyAoUmVxIDQuMywgNC40KS4gVGhlIHNjaGVtYSBleHBvc2VzIHRoZSBzdWJzY3JpcHRpb25zIGFuZFxuICAgIC8vIG5vbi1udWxsYWJsZSBzdG9yZWQgYXR0cmlidXRlcyAoUmVxIDUuMSwgNS45LCA1LjEwKS5cbiAgICB0aGlzLmFwaSA9IG5ldyBHcmFwaHFsQXBpKHRoaXMsICdHcmFwaHFsQXBpJywge1xuICAgICAgbmFtZTogJ0hlYWx0aE9taWNzV29ya2Zsb3dEYXNoYm9hcmQnLFxuICAgICAgZGVmaW5pdGlvbjogRGVmaW5pdGlvbi5mcm9tRmlsZShTQ0hFTUFfUEFUSCksXG4gICAgICBhdXRob3JpemF0aW9uQ29uZmlnOiB7XG4gICAgICAgIGRlZmF1bHRBdXRob3JpemF0aW9uOiB7XG4gICAgICAgICAgYXV0aG9yaXphdGlvblR5cGU6IEF1dGhvcml6YXRpb25UeXBlLlVTRVJfUE9PTCxcbiAgICAgICAgICB1c2VyUG9vbENvbmZpZzogeyB1c2VyUG9vbDogdGhpcy51c2VyUG9vbCB9LFxuICAgICAgICB9LFxuICAgICAgICBhZGRpdGlvbmFsQXV0aG9yaXphdGlvbk1vZGVzOiBbXG4gICAgICAgICAgeyBhdXRob3JpemF0aW9uVHlwZTogQXV0aG9yaXphdGlvblR5cGUuSUFNIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRHluYW1vREIgZGF0YSBzb3VyY2UgYmFja2VkIGJ5IHRoZSBzaW5nbGUgdGFibGUgZnJvbSB0aGUgZGF0YSBsYXllci4gVGhlXG4gICAgLy8gcmVhZCBxdWVyaWVzIHJlc29sdmUgZGlyZWN0bHkgYWdhaW5zdCBpdCB3aXRoIEFQUFNZTkNfSlMgcmVzb2x2ZXJzXG4gICAgLy8gKFJlcSA1LjExKS5cbiAgICAvL1xuICAgIC8vIFRoZSBkYXRhIHNvdXJjZSBhc3N1bWVzIGEgZGVkaWNhdGVkIEFwcFN5bmMgc2VydmljZSByb2xlIHNjb3BlZCB0b1xuICAgIC8vIFJFQUQtT05MWSBEeW5hbW9EQiBhY2Nlc3MuIGByZWFkT25seUFjY2VzczogdHJ1ZWAgbWFrZXMgQ0RLIGdyYW50IG9ubHlcbiAgICAvLyByZWFkIGRhdGEgYWN0aW9ucyBvbiB0aGUgdGFibGUgYW5kIGl0cyBpbmRleGVzIGFuZCBORVZFUiBhbnkgd3JpdGUgYWN0aW9uXG4gICAgLy8gKHRoZSBkZWZhdWx0IGBhZGREeW5hbW9EYkRhdGFTb3VyY2VgIHdvdWxkIGdyYW50IHJlYWQrd3JpdGUpLiBUaGUgcmVhZFxuICAgIC8vIGdyYW50IGNhcnJpZXMgbm8gYEFjdGlvbjogXCIqXCJgIGFuZCBubyBgUmVzb3VyY2U6IFwiKlwiYCDigJQgaXQgaXMgY29uZmluZWQgdG9cbiAgICAvLyB0aGUgdGFibGUncyBvd24gQVJOIGFuZCBpbmRleCBBUk5zIChSZXEgMTEuMikuIFRoZSBxdWVyeSByZXNvbHZlcnMgb25seVxuICAgIC8vIGV2ZXIgR2V0SXRlbSAoZ2V0UnVuKSBvciBRdWVyeSAobGlzdFJ1bnMgdmlhIEdTSTEsIGxpc3RUYXNrc0ZvclJ1biB2aWFcbiAgICAvLyB0aGUgdGFibGUpLCBhbGwgb2Ygd2hpY2ggZmFsbCB3aXRoaW4gdGhpcyByZWFkLW9ubHkgZ3JhbnQuXG4gICAgY29uc3QgZHluYW1vRGF0YVNvdXJjZSA9IG5ldyBEeW5hbW9EYkRhdGFTb3VyY2UodGhpcywgJ0R5bmFtb0RhdGFTb3VyY2UnLCB7XG4gICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgdGFibGU6IHByb3BzLmRhdGFTdGFjay50YWJsZSxcbiAgICAgIHJlYWRPbmx5QWNjZXNzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRSZWFkUmVzb2x2ZXJzKGR5bmFtb0RhdGFTb3VyY2UpO1xuICAgIHRoaXMuYWRkUHVibGlzaFJlc29sdmVycygpO1xuICAgIHRoaXMuYWRkTG9nc1Jlc29sdmVyKCk7XG4gICAgdGhpcy5hZGRNZXRyaWNzUmVzb2x2ZXIoKTtcbiAgICB0aGlzLmFkZENvc3RSZXNvbHZlcihwcm9wcy5kYXRhU3RhY2sudGFibGUpO1xuICAgIHRoaXMuYWRkUmVwb3J0c1Jlc29sdmVyKHByb3BzLmRhdGFTdGFjay50YWJsZSwgcHJvcHMuZGF0YVN0YWNrLmdzaTJOYW1lKTtcblxuICAgIHRoaXMuYWRkT3V0cHV0cygpO1xuICB9XG5cbiAgLyoqXG4gICAqIExhbWJkYS1iYWNrZWQgcmVzb2x2ZXIgZm9yIHRoZSBgZ2V0UnVuTG9nc2AgYW5kIGBnZXRFcnJvckV4Y2VycHRgIHF1ZXJpZXMuXG4gICAqXG4gICAqIEFQUFNZTkNfSlMgcmVzb2x2ZXJzIGNhbm5vdCBjYWxsIENsb3VkV2F0Y2ggTG9ncywgc28gYm90aCBxdWVyaWVzIGFyZVxuICAgKiBiYWNrZWQgYnkgYSBzaW5nbGUgc21hbGwgTm9kZWpzRnVuY3Rpb24gKGluZ2VzdC9zcmMvbG9nc0hhbmRsZXIudHMsIGVudHJ5XG4gICAqIHBvaW50IGByb3V0ZXJgKSBleHBvc2VkIGFzIG9uZSBBcHBTeW5jIExhbWJkYSBkYXRhIHNvdXJjZSDigJQgYSBkaXJlY3RcbiAgICogTGFtYmRhIHJlc29sdmVyIHdpdGggbm8gcmVxdWVzdC9yZXNwb25zZSBtYXBwaW5nIHRlbXBsYXRlLCBzbyBBcHBTeW5jXG4gICAqIHBhc3NlcyB0aGUgZW50aXJlIHJlc29sdmVyIGNvbnRleHQgKGluY2x1ZGluZyBgaW5mby5maWVsZE5hbWVgKSBhbmQgdGhlXG4gICAqIGZ1bmN0aW9uIGRpc3BhdGNoZXMgb24gaXQgKGNvbmZpcm1lZCBhZ2FpbnN0IHRoZSBBV1MgQXBwU3luY1xuICAgKiBkaXJlY3QtTGFtYmRhLXJlc29sdmVyIHJlZmVyZW5jZSkuIGBnZXRFcnJvckV4Y2VycHRgIChPcHRpb24gQjogZXh0cmFjdFxuICAgKiB0aGUgYWN0dWFsIGVycm9yIGZyb20gdGhlIGxvZyBzdHJlYW0gcmF0aGVyIHRoYW4gcmVseWluZyBvbiBIZWFsdGhPbWljcydcbiAgICogb2Z0ZW4tZ2VuZXJpYyBgc3RhdHVzTWVzc2FnZWApIHJldXNlcyB0aGUgc2FtZSBDbG91ZFdhdGNoIExvZ3MgSUFNIGdyYW50XG4gICAqIGFzIGBnZXRSdW5Mb2dzYCDigJQgbm8gbmV3IHBlcm1pc3Npb25zIG5lZWRlZCwgc2luY2UgaXQgcmVhZHMgdGhlIGlkZW50aWNhbFxuICAgKiBsb2cgZ3JvdXAvc3RyZWFtcy4gVGhlIExhbWJkYSBpcyBncmFudGVkIFJFQUQtT05MWSBhY2Nlc3MgdG8gdGhlXG4gICAqIEhlYWx0aE9taWNzIHJ1biBsb2cgZ3JvdXAgb25seSAobm8gd2lsZGNhcmRzLCBSZXEgMTEuMiksIGFuZCBib3RoIHF1ZXJpZXNcbiAgICogYXJlIENvZ25pdG8tYXV0aG9yaXplZCBsaWtlIHRoZSBvdGhlciByZWFkcy5cbiAgICovXG4gIHByaXZhdGUgYWRkTG9nc1Jlc29sdmVyKCk6IHZvaWQge1xuICAgIGNvbnN0IGxvZ3NGbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnTG9nc0Z1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGVudHJ5OiBMT0dTX0hBTkRMRVJfRU5UUlksXG4gICAgICBoYW5kbGVyOiAncm91dGVyJyxcbiAgICAgIHByb2plY3RSb290OiBJTkdFU1RfUFJPSkVDVF9ST09ULFxuICAgICAgZGVwc0xvY2tGaWxlUGF0aDogSU5HRVNUX0RFUFNfTE9DS19GSUxFLFxuICAgICAgdGltZW91dDogRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBMT0dfR1JPVVBfTkFNRTogT01JQ1NfTE9HX0dST1VQLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIGZvcm1hdDogT3V0cHV0Rm9ybWF0LkVTTSxcbiAgICAgICAgZXh0ZXJuYWxNb2R1bGVzOiBbJ0Bhd3Mtc2RrLyonXSxcbiAgICAgICAgLy8gVGhlIEBzbWl0aHkgSFRUUCBoYW5kbGVyIChidW5kbGVkIHZpYSBgTm9kZUh0dHBIYW5kbGVyYCwgdXNlZCB0byBzZXRcbiAgICAgICAgLy8gdGhlIENsb3VkV2F0Y2ggTG9ncyBjbGllbnQncyBjb25uZWN0L3JlcXVlc3QgdGltZW91dHMpIGludGVybmFsbHkgdXNlc1xuICAgICAgICAvLyBDb21tb25KUyBgcmVxdWlyZSguLi4pYCAoZS5nLiBgbm9kZTpodHRwc2ApLiBCdW5kbGluZyB0aGF0IENKUyBpbnRvIGFuXG4gICAgICAgIC8vIEVTTSBvdXRwdXQgbWFrZXMgdGhvc2UgZHluYW1pYyByZXF1aXJlcyBmYWlsIGF0IHJ1bnRpbWUgKFwiRHluYW1pY1xuICAgICAgICAvLyByZXF1aXJlIG9mIFxcXCJub2RlOmh0dHBzXFxcIiBpcyBub3Qgc3VwcG9ydGVkXCIpLCB3aGljaCBjcmFzaGVzIHRoZVxuICAgICAgICAvLyBmdW5jdGlvbiBhdCBJTklUIGFuZCBzdXJmYWNlcyBpbiB0aGUgVUkgYXMgXCJMb2dzIGNvdWxkIG5vdCBiZSBsb2FkZWRcIi5cbiAgICAgICAgLy8gSW5qZWN0IGEgY3JlYXRlUmVxdWlyZSBzaGltIHNvIHRoZSBidW5kbGVkIENKUyBtb2R1bGVzIGNhbiByZXNvbHZlXG4gICAgICAgIC8vIHRoZWlyIHJlcXVpcmVzIHVuZGVyIEVTTSAoc2FtZSBmaXggdGhlIGluZ2VzdCBMYW1iZGEgdXNlcykuXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBMZWFzdC1wcml2aWxlZ2U6IHJlYWQtb25seSBhY2Nlc3MgdG8gdGhlIEhlYWx0aE9taWNzIHJ1biBsb2cgZ3JvdXAgYW5kXG4gICAgLy8gaXRzIHN0cmVhbXMgb25seS4gTm8gd2lsZGNhcmQgYWN0aW9uLCBubyB3aWxkY2FyZCByZXNvdXJjZSAoUmVxIDExLjIpLlxuICAgIC8vIENsb3VkV2F0Y2ggbG9nLWdyb3VwIEFSTnMgdXNlIGEgQ09MT04gc2VwYXJhdG9yIGJlZm9yZSB0aGUgKGxlYWRpbmctc2xhc2gpXG4gICAgLy8gZ3JvdXAgbmFtZTogYXJuOmF3czpsb2dzOjxyZWdpb24+OjxhY2N0Pjpsb2ctZ3JvdXA6L2F3cy9vbWljcy9Xb3JrZmxvd0xvZy5cbiAgICAvLyBCdWlsZCBpdCBleHBsaWNpdGx5IHRvIGF2b2lkIGZvcm1hdEFybiBpbnNlcnRpbmcgYSBzbGFzaCBzZXBhcmF0b3IgKHdoaWNoXG4gICAgLy8gd291bGQgeWllbGQgYW4gaW52YWxpZCBgbG9nLWdyb3VwLy9hd3MvLi4uYCkuIFRoZSBgOipgIHZhcmlhbnQgY292ZXJzIHRoZVxuICAgIC8vIGdyb3VwJ3MgbG9nIHN0cmVhbXMuXG4gICAgY29uc3QgeyByZWdpb24sIGFjY291bnQgfSA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGNvbnN0IGxvZ0dyb3VwQXJuID0gYGFybjphd3M6bG9nczoke3JlZ2lvbn06JHthY2NvdW50fTpsb2ctZ3JvdXA6JHtPTUlDU19MT0dfR1JPVVB9YDtcbiAgICBsb2dzRm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ2xvZ3M6R2V0TG9nRXZlbnRzJyxcbiAgICAgICAgICAnbG9nczpGaWx0ZXJMb2dFdmVudHMnLFxuICAgICAgICAgICdsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcycsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwQXJuLCBgJHtsb2dHcm91cEFybn06KmBdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGNvbnN0IGxvZ3NEYXRhU291cmNlID0gdGhpcy5hcGkuYWRkTGFtYmRhRGF0YVNvdXJjZShcbiAgICAgICdMb2dzRGF0YVNvdXJjZScsXG4gICAgICBsb2dzRm4sXG4gICAgKTtcblxuICAgIC8vIERlZmF1bHQgcmVxdWVzdC9yZXNwb25zZSBtYXBwaW5nIHBhc3NlcyB0aGUgZW50aXJlIHJlc29sdmVyIGNvbnRleHRcbiAgICAvLyB0aHJvdWdoIHRvIHRoZSBMYW1iZGEgKGRpcmVjdCBMYW1iZGEgcmVzb2x2ZXIpIGFuZCByZXR1cm5zIGl0cyByZXN1bHRcbiAgICAvLyBhcy1pcy4gT25lIHJlc29sdmVyIHBlciBmaWVsZCwgYm90aCBvbiB0aGUgc2FtZSBMYW1iZGEgZGF0YSBzb3VyY2U7IHRoZVxuICAgIC8vIExhbWJkYSdzIGByb3V0ZXJgIGVudHJ5IHBvaW50IGRpc3BhdGNoZXMgb24gYGluZm8uZmllbGROYW1lYC5cbiAgICBsb2dzRGF0YVNvdXJjZS5jcmVhdGVSZXNvbHZlcignZ2V0UnVuTG9nc1Jlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdnZXRSdW5Mb2dzJyxcbiAgICB9KTtcbiAgICBsb2dzRGF0YVNvdXJjZS5jcmVhdGVSZXNvbHZlcignZ2V0RXJyb3JFeGNlcnB0UmVzb2x2ZXInLCB7XG4gICAgICB0eXBlTmFtZTogJ1F1ZXJ5JyxcbiAgICAgIGZpZWxkTmFtZTogJ2dldEVycm9yRXhjZXJwdCcsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogTGFtYmRhLWJhY2tlZCByZXNvbHZlciBmb3IgdGhlIGBnZXRSdW5NZXRyaWNzYCBxdWVyeS5cbiAgICpcbiAgICogVGhlcmUgaXMgbm8gQVdTIFNESyBvcGVyYXRpb24gZm9yIENsb3VkV2F0Y2gncyBQcm9tZXRoZXVzLWNvbXBhdGlibGVcbiAgICogUHJvbVFMIEFQSSwgc28gYGdldFJ1bk1ldHJpY3NgIGlzIGJhY2tlZCBieSBhIE5vZGVqc0Z1bmN0aW9uXG4gICAqIChpbmdlc3Qvc3JjL21ldHJpY3NIYW5kbGVyLnRzKSB0aGF0IGJ1aWxkcyBhbmQgU2lnVjQtc2lnbnMgYSByYXcgSFRUUFNcbiAgICogUE9TVCBpdHNlbGYsIGV4cG9zZWQgYXMgYW4gQXBwU3luYyBMYW1iZGEgZGF0YSBzb3VyY2UgKG1pcnJvcnNcbiAgICogYGFkZExvZ3NSZXNvbHZlcmApLiBUaGUgcXVlcnkgaXMgQ29nbml0by1hdXRob3JpemVkIGxpa2UgdGhlIG90aGVyIHJlYWRzLlxuICAgKlxuICAgKiBMZWFzdC1wcml2aWxlZ2UgSUFNLCBWRVJJRklFRC1SRVFVSVJFRCAoZW1waXJpY2FsbHkgY29uZmlybWVkIHZpYSBhIGxpdmVcbiAgICogc2NvcGVkLXJvbGUgdGVzdCArIEFXUyBkb2NzIOKAlCBzZWUgZGVzaWduLm1kIElBTSBzZWN0aW9uKTogdGhlIENsb3VkV2F0Y2hcbiAgICogUHJvbVFMIGBRdWVyeU1ldHJpY3NgIG9wZXJhdGlvbiByZXF1aXJlcyBCT1RIIGBjbG91ZHdhdGNoOkdldE1ldHJpY0RhdGFgXG4gICAqIEFORCBgY2xvdWR3YXRjaDpMaXN0TWV0cmljc2AuIGBSZXNvdXJjZTogJyonYCBpcyB1c2VkIGZvciB0aGVzZSB0d29cbiAgICogYWN0aW9ucyBiZWNhdXNlIHRoZXkgZG8gbm90IHN1cHBvcnQgcmVzb3VyY2UtbGV2ZWwgQVJOIHNjb3Bpbmcg4oCUXG4gICAqIGNvbmZpcm1lZCBieSB0aGUgNDAzIG1lc3NhZ2UgcmV0dXJuZWQgZHVyaW5nIHZlcmlmaWNhdGlvbiwgd2hpY2ggbmFtZWQgYVxuICAgKiBkYXRhc2V0IEFSTiBDbG91ZFdhdGNoIGNvbnRyb2xzIGludGVybmFsbHksIG5vdCBhIGN1c3RvbWVyLXNjb3BhYmxlXG4gICAqIHJlc291cmNlLiBUaGlzIGlzIGEgZG9jdW1lbnRlZCBleGNlcHRpb24gdG8gdGhlIG5vLXdpbGRjYXJkLXJlc291cmNlXG4gICAqIHBhdHRlcm4gdXNlZCBlbHNld2hlcmUgaW4gdGhpcyBzdGFjaywgYnV0IGl0IGlzIE5PVCBhIHdpbGRjYXJkIGFjdGlvblxuICAgKiAobm8gYEFjdGlvbjogJyonYCkuXG4gICAqXG4gICAqIEEgc2VwYXJhdGUsIG5hcnJvdyBgb21pY3M6R2V0UnVuYCBncmFudCBzY29wZWQgdG8gcnVuIEFSTnMgYmFja3MgdGhlXG4gICAqIHdpbmRvdy1yZXNvbHV0aW9uIGZhbGxiYWNrIChkZXNpZ24gXCJSdW4gd2luZG93XCIgZGVjaXNpb24pOiBpdCBpcyB1c2VkXG4gICAqIG9ubHkgd2hlbiB0aGUgY2FsbGVyIG9taXRzIGBzdGFydFRpbWVgL2BlbmRUaW1lYC5cbiAgICovXG4gIHByaXZhdGUgYWRkTWV0cmljc1Jlc29sdmVyKCk6IHZvaWQge1xuICAgIGNvbnN0IG1ldHJpY3NGbiA9IG5ldyBOb2RlanNGdW5jdGlvbih0aGlzLCAnTWV0cmljc0Z1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogUnVudGltZS5OT0RFSlNfMjBfWCxcbiAgICAgIGVudHJ5OiBNRVRSSUNTX0hBTkRMRVJfRU5UUlksXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBwcm9qZWN0Um9vdDogSU5HRVNUX1BST0pFQ1RfUk9PVCxcbiAgICAgIGRlcHNMb2NrRmlsZVBhdGg6IElOR0VTVF9ERVBTX0xPQ0tfRklMRSxcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTUVUUklDU19SRUdJT046IFN0YWNrLm9mKHRoaXMpLnJlZ2lvbixcbiAgICAgICAgTU9OSVRPUklOR19IT1NUOiBgbW9uaXRvcmluZy4ke1N0YWNrLm9mKHRoaXMpLnJlZ2lvbn0uYW1hem9uYXdzLmNvbWAsXG4gICAgICAgIFNJR05JTkdfU0VSVklDRTogJ21vbml0b3JpbmcnLFxuICAgICAgfSxcbiAgICAgIGJ1bmRsaW5nOiB7XG4gICAgICAgIGZvcm1hdDogT3V0cHV0Rm9ybWF0LkVTTSxcbiAgICAgICAgLy8gRXh0ZXJuYWxpemUgb25seSB0aGUgQVdTIFNESyBtb2R1bGVzIHByZXNlbnQgaW4gdGhlIExhbWJkYSBydW50aW1lLlxuICAgICAgICAvLyBAc21pdGh5L3NpZ25hdHVyZS12NCBhbmQgQGF3cy1jcnlwdG8vc2hhMjU2LWpzIGFyZSBOT1QgaW4gdGhlXG4gICAgICAgIC8vIHJ1bnRpbWUsIHNvIHRoZXkgYXJlIGJ1bmRsZWQgKE5PVCBleHRlcm5hbGl6ZWQpIOKAlCB0aGlzIGlzIHRoZSBrZXlcbiAgICAgICAgLy8gZGlmZmVyZW5jZSBmcm9tIGFkZExvZ3NSZXNvbHZlcidzIGJ1bmRsaW5nLlxuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnQGF3cy1zZGsvKiddLFxuICAgICAgICAvLyBAc21pdGh5L3NpZ25hdHVyZS12NCBhbmQgQGF3cy1jcnlwdG8vc2hhMjU2LWpzIGFyZSBhdXRob3JlZCBhc1xuICAgICAgICAvLyBDb21tb25KUyBhbmQgaW50ZXJuYWxseSB1c2UgYHJlcXVpcmUoLi4uKWAgKGUuZy4gZm9yIE5vZGUgYnVpbHQtaW5zXG4gICAgICAgIC8vIGxpa2UgXCJidWZmZXJcIikuIEJ1bmRsaW5nIENKUyBpbnRvIGFuIEVTTSBvdXRwdXQgbGVhdmVzIG5vIGByZXF1aXJlYFxuICAgICAgICAvLyBpbiBzY29wZSwgc28gdGhvc2UgZHluYW1pYyByZXF1aXJlcyBjcmFzaCBhdCBydW50aW1lIHdpdGggXCJEeW5hbWljXG4gICAgICAgIC8vIHJlcXVpcmUgb2YgLi4uIGlzIG5vdCBzdXBwb3J0ZWRcIiAoY29uZmlybWVkIHZpYSBDbG91ZFdhdGNoIExvZ3MpLlxuICAgICAgICAvLyBJbmplY3QgdGhlIHNhbWUgY3JlYXRlUmVxdWlyZSBzaGltIHVzZWQgYnkgSW5nZXN0U3RhY2sncyBidW5kbGluZyBzb1xuICAgICAgICAvLyB0aGUgYnVuZGxlZCBDSlMgbW9kdWxlcyBjYW4gcmVzb2x2ZSB0aGVpciByZXF1aXJlcyB1bmRlciBFU00uXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBMZWFzdC1wcml2aWxlZ2UgSUFNLCBWRVJJRklFRC1SRVFVSVJFRCAoZW1waXJpY2FsbHkgY29uZmlybWVkIHZpYSBhXG4gICAgLy8gbGl2ZSBzY29wZWQtcm9sZSB0ZXN0ICsgQVdTIGRvY3Mg4oCUIHNlZSBkZXNpZ24ubWQgSUFNIHNlY3Rpb24pOiB0aGVcbiAgICAvLyBDbG91ZFdhdGNoIFByb21RTCBRdWVyeU1ldHJpY3Mgb3BlcmF0aW9uIHJlcXVpcmVzIEJPVEggYWN0aW9ucyBiZWxvdy5cbiAgICAvLyBSZXNvdXJjZSAnKicgYmVjYXVzZSB0aGVzZSBDbG91ZFdhdGNoIG1ldHJpYy1kYXRhIGFjdGlvbnMgZG8gbm90XG4gICAgLy8gc3VwcG9ydCByZXNvdXJjZS1sZXZlbCBBUk4gc2NvcGluZyAoY29uZmlybWVkIGJ5IHRoZSA0MDMgbWVzc2FnZVxuICAgIC8vIGR1cmluZyB2ZXJpZmljYXRpb24sIHdoaWNoIG5hbWVkIGEgZGF0YXNldCBBUk4gQ2xvdWRXYXRjaCBjb250cm9sc1xuICAgIC8vIGludGVybmFsbHksIG5vdCBhIGN1c3RvbWVyLXNjb3BhYmxlIHJlc291cmNlKS4gTm8gQWN0aW9uOiAnKicuXG4gICAgbWV0cmljc0ZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydjbG91ZHdhdGNoOkdldE1ldHJpY0RhdGEnLCAnY2xvdWR3YXRjaDpMaXN0TWV0cmljcyddLFxuICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIE5hcnJvdywgcnVuLUFSTi1zY29wZWQgZmFsbGJhY2sgcGVybWlzc2lvbiBmb3IgdGhlIHdpbmRvdy1yZXNvbHV0aW9uXG4gICAgLy8gR2V0UnVuIGNhbGwgKGRlc2lnbiBcIlJ1biB3aW5kb3dcIiBkZWNpc2lvbikg4oCUIG9ubHkgdXNlZCB3aGVuIHRoZVxuICAgIC8vIGNhbGxlciBvbWl0cyBzdGFydFRpbWUvZW5kVGltZS5cbiAgICBjb25zdCB7IHJlZ2lvbiwgYWNjb3VudCB9ID0gU3RhY2sub2YodGhpcyk7XG4gICAgbWV0cmljc0ZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydvbWljczpHZXRSdW4nXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6b21pY3M6JHtyZWdpb259OiR7YWNjb3VudH06cnVuLypgXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBjb25zdCBtZXRyaWNzRGF0YVNvdXJjZSA9IHRoaXMuYXBpLmFkZExhbWJkYURhdGFTb3VyY2UoXG4gICAgICAnTWV0cmljc0RhdGFTb3VyY2UnLFxuICAgICAgbWV0cmljc0ZuLFxuICAgICk7XG5cbiAgICBtZXRyaWNzRGF0YVNvdXJjZS5jcmVhdGVSZXNvbHZlcignZ2V0UnVuTWV0cmljc1Jlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdnZXRSdW5NZXRyaWNzJyxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBMYW1iZGEtYmFja2VkIHJlc29sdmVyIGZvciB0aGUgYGdldFJ1bkNvc3RFc3RpbWF0ZWAgcXVlcnkuXG4gICAqXG4gICAqIE1pcnJvcnMgYGFkZE1ldHJpY3NSZXNvbHZlcigpYDogYSBOb2RlanNGdW5jdGlvblxuICAgKiAoaW5nZXN0L3NyYy9jb3N0SGFuZGxlci50cykgZXhwb3NlZCBhcyBhbiBBcHBTeW5jIExhbWJkYSBkYXRhIHNvdXJjZSxcbiAgICogQ29nbml0by1hdXRob3JpemVkIGxpa2UgdGhlIG90aGVyIHJlYWRzLiBJdCBidW5kbGVzIHRoZSBzYW1lXG4gICAqIGBAc21pdGh5L3NpZ25hdHVyZS12NGAvYEBhd3MtY3J5cHRvL3NoYTI1Ni1qc2AgQ0pTLWluLUVTTSBkZXBzIChmb3IgdGhlXG4gICAqIERZTkFNSUMtc3RvcmFnZSBSVU5fRklMRVNZU1RFTSBQcm9tUUwgcXVlcnkpLCBzbyBpdCBjYXJyaWVzIHRoZSBpZGVudGljYWxcbiAgICogRVNNIGBjcmVhdGVSZXF1aXJlYCBiYW5uZXIgc2hpbS5cbiAgICpcbiAgICogTGVhc3QtcHJpdmlsZWdlIElBTTpcbiAgICogLSBgcHJpY2luZzpHZXRQcm9kdWN0c2AvYHByaWNpbmc6RGVzY3JpYmVTZXJ2aWNlc2Agb24gUmVzb3VyY2UgJyonIOKAlCB0aGVcbiAgICogICBQcmljZSBMaXN0IEFQSSBkb2VzIE5PVCBzdXBwb3J0IHJlc291cmNlLWxldmVsIHNjb3BpbmcsIGEgRE9DVU1FTlRFRFxuICAgKiAgIGV4Y2VwdGlvbiB0byB0aGUgbm8td2lsZGNhcmQtcmVzb3VyY2UgcGF0dGVybiAobGlrZSB0aGUgQ2xvdWRXYXRjaFxuICAgKiAgIG1ldHJpY3MgZ3JhbnQpLiBOT1QgYSB3aWxkY2FyZCBhY3Rpb24uXG4gICAqIC0gYGNsb3Vkd2F0Y2g6R2V0TWV0cmljRGF0YWAvYGNsb3Vkd2F0Y2g6TGlzdE1ldHJpY3NgIG9uIFJlc291cmNlICcqJyDigJQgdGhlXG4gICAqICAgc2FtZSBDbG91ZFdhdGNoIFByb21RTCBncmFudCBhcyB0aGUgbWV0cmljcyBMYW1iZGEgKG5vIHJlc291cmNlLWxldmVsXG4gICAqICAgc2NvcGluZykuIE5PVCBhIHdpbGRjYXJkIGFjdGlvbi5cbiAgICogLSBgb21pY3M6R2V0UnVuYCBzY29wZWQgdG8gcnVuIEFSTnMgZm9yIHRoZSBydW4gd2luZG93L3N0b3JhZ2UgZmllbGRzLlxuICAgKiAtIGEgRHluYW1vREIgZ3JhbnQgc2NvcGVkIHRvIHRoZSBzaW5nbGUtdGFibGUgQVJOLCBsaW1pdGVkIHRvXG4gICAqICAgR2V0SXRlbS9QdXRJdGVtL1VwZGF0ZUl0ZW0gZm9yIHRoZSByYXRlLWNhcmQgY2FjaGUgaXRlbS5cbiAgICpcbiAgICogTm8gc3RhdGVtZW50IGNhcnJpZXMgYEFjdGlvbjogJyonYC5cbiAgICovXG4gIHByaXZhdGUgYWRkQ29zdFJlc29sdmVyKHRhYmxlOiBEYXRhU3RhY2tbJ3RhYmxlJ10pOiB2b2lkIHtcbiAgICBjb25zdCBjb3N0Rm4gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ0Nvc3RGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogQ09TVF9IQU5ETEVSX0VOVFJZLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgcHJvamVjdFJvb3Q6IElOR0VTVF9QUk9KRUNUX1JPT1QsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBJTkdFU1RfREVQU19MT0NLX0ZJTEUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENPU1RfUkVHSU9OOiBTdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICAgIENPU1RfVEFCTEVfTkFNRTogdGFibGUudGFibGVOYW1lLFxuICAgICAgICBNT05JVE9SSU5HX0hPU1Q6IGBtb25pdG9yaW5nLiR7U3RhY2sub2YodGhpcykucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcbiAgICAgICAgU0lHTklOR19TRVJWSUNFOiAnbW9uaXRvcmluZycsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgZm9ybWF0OiBPdXRwdXRGb3JtYXQuRVNNLFxuICAgICAgICAvLyBzaWduYXR1cmUtdjQvc2hhMjU2IGJ1bmRsZWQgKG5vdCBleHRlcm5hbGl6ZWQpLCBsaWtlIHRoZSBtZXRyaWNzXG4gICAgICAgIC8vIExhbWJkYSDigJQgQGF3cy1zZGsvKiBzdGF5cyBleHRlcm5hbCBhcyBpdCBpcyBpbiB0aGUgTm9kZSBydW50aW1lLlxuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnQGF3cy1zZGsvKiddLFxuICAgICAgICAvLyBJbmplY3QgdGhlIGNyZWF0ZVJlcXVpcmUgc2hpbSBzbyB0aGUgYnVuZGxlZCBDSlMgZGVwcyBjYW4gcmVzb2x2ZVxuICAgICAgICAvLyB0aGVpciBkeW5hbWljIHJlcXVpcmVzIHVuZGVyIEVTTSAoc2VlIGFkZE1ldHJpY3NSZXNvbHZlcikuXG4gICAgICAgIGJhbm5lcjpcbiAgICAgICAgICBcImltcG9ydHtjcmVhdGVSZXF1aXJlIGFzIF9fY3JlYXRlUmVxdWlyZX1mcm9tJ21vZHVsZSc7Y29uc3QgcmVxdWlyZT1fX2NyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcIixcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBQcmljZSBMaXN0OiByZWFkLW9ubHkgYWN0aW9ucy4gUmVzb3VyY2UgJyonIGJlY2F1c2UgdGhlIFByaWNlIExpc3QgQVBJXG4gICAgLy8gZG9lcyBOT1Qgc3VwcG9ydCByZXNvdXJjZS1sZXZlbCBzY29waW5nIOKAlCBhbiBpbnRlbnRpb25hbCwgRE9DVU1FTlRFRFxuICAgIC8vIGV4Y2VwdGlvbiB0byB0aGUgbm8td2lsZGNhcmQtcmVzb3VyY2UgcGF0dGVybiwgZXhhY3RseSBsaWtlIHRoZSBleGlzdGluZ1xuICAgIC8vIENsb3VkV2F0Y2ggbWV0cmljcyBncmFudC4gTk9UIGEgd2lsZGNhcmQgYWN0aW9uIChSZXEgNy4xLCA3LjIsIDcuMykuXG4gICAgY29zdEZuLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBlZmZlY3Q6IEVmZmVjdC5BTExPVyxcbiAgICAgICAgYWN0aW9uczogWydwcmljaW5nOkdldFByb2R1Y3RzJywgJ3ByaWNpbmc6RGVzY3JpYmVTZXJ2aWNlcyddLFxuICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIC8vIENsb3VkV2F0Y2ggUHJvbVFMIChEWU5BTUlDLXN0b3JhZ2UgUlVOX0ZJTEVTWVNURU0gR0ItaG91cnMpLCBzYW1lIGdyYW50XG4gICAgLy8gYXMgdGhlIG1ldHJpY3MgTGFtYmRhOyBSZXNvdXJjZSAnKicgKG5vIHJlc291cmNlLWxldmVsIHNjb3BpbmcpLCBOT1QgYVxuICAgIC8vIHdpbGRjYXJkIGFjdGlvbi5cbiAgICBjb3N0Rm4uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IFBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGVmZmVjdDogRWZmZWN0LkFMTE9XLFxuICAgICAgICBhY3Rpb25zOiBbJ2Nsb3Vkd2F0Y2g6R2V0TWV0cmljRGF0YScsICdjbG91ZHdhdGNoOkxpc3RNZXRyaWNzJ10sXG4gICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gb21pY3M6R2V0UnVuIGZvciB0aGUgcnVuIHdpbmRvdy9zdG9yYWdlIGZpZWxkcywgc2NvcGVkIHRvIHJ1biBBUk5zIChub1xuICAgIC8vIHdpbGRjYXJkIGFjdGlvbikuXG4gICAgY29uc3QgeyByZWdpb24sIGFjY291bnQgfSA9IFN0YWNrLm9mKHRoaXMpO1xuICAgIGNvc3RGbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgZWZmZWN0OiBFZmZlY3QuQUxMT1csXG4gICAgICAgIGFjdGlvbnM6IFsnb21pY3M6R2V0UnVuJ10sXG4gICAgICAgIHJlc291cmNlczogW2Bhcm46YXdzOm9taWNzOiR7cmVnaW9ufToke2FjY291bnR9OnJ1bi8qYF0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgLy8gRHluYW1vREIgYWNjZXNzLCBzY29wZWQgdG8gdGhlIHNpbmdsZSB0YWJsZSBBUk4gKGxlYXN0IHByaXZpbGVnZSwgbGlrZVxuICAgIC8vIHRoZSBleGlzdGluZyBncmFudHMpOlxuICAgIC8vICAgLSBRdWVyeTogbGlzdCB0aGUgcnVuJ3MgdGFzayBpdGVtcyAoUEsgPSBSVU4jPHJ1bklkPiwgU0sgYmVnaW5zX3dpdGhcbiAgICAvLyAgICAgVEFTSyMpIGluIHRoZSBjb3N0IGhhbmRsZXIncyBsb2FkUnVuVGFza3MuXG4gICAgLy8gICAtIEdldEl0ZW0vUHV0SXRlbS9VcGRhdGVJdGVtOiB0aGUgcmVnaW9uIHJhdGUtY2FyZCBjYWNoZSBpdGVtLlxuICAgIHRhYmxlLmdyYW50KFxuICAgICAgY29zdEZuLFxuICAgICAgJ2R5bmFtb2RiOlF1ZXJ5JyxcbiAgICAgICdkeW5hbW9kYjpHZXRJdGVtJyxcbiAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcbiAgICAgICdkeW5hbW9kYjpVcGRhdGVJdGVtJyxcbiAgICApO1xuXG4gICAgY29uc3QgY29zdERhdGFTb3VyY2UgPSB0aGlzLmFwaS5hZGRMYW1iZGFEYXRhU291cmNlKFxuICAgICAgJ0Nvc3REYXRhU291cmNlJyxcbiAgICAgIGNvc3RGbixcbiAgICApO1xuXG4gICAgY29zdERhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2dldFJ1bkNvc3RFc3RpbWF0ZVJlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdnZXRSdW5Db3N0RXN0aW1hdGUnLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIExhbWJkYS1iYWNrZWQgcmVzb2x2ZXIgZm9yIHRoZSBgbGlzdFdvcmtmbG93R3JvdXBzYCBhbmQgYGdldFdvcmtmbG93UmVwb3J0YFxuICAgKiBxdWVyaWVzICh3b3JrZmxvdy1wZXJmb3JtYW5jZS1yZXBvcnRzKS4gT25lIE5vZGVqc0Z1bmN0aW9uIGJhY2tzIGJvdGhcbiAgICogZmllbGRzLCBkaXNwYXRjaGVkIG9uIGBpbmZvLmZpZWxkTmFtZWAgKGRpcmVjdC1MYW1iZGEtcmVzb2x2ZXIgcm91dGVyLCBsaWtlXG4gICAqIGBhZGRMb2dzUmVzb2x2ZXJgKS4gQm90aCBxdWVyaWVzIGFyZSBDb2duaXRvLWF1dGhvcml6ZWQgbGlrZSB0aGUgb3RoZXJcbiAgICogcmVhZHMuXG4gICAqXG4gICAqIExlYXN0LXByaXZpbGVnZSBJQU06IHRoZSBMYW1iZGEgb25seSByZWFkcyB0aGUgc2luZ2xlIHRhYmxlIOKAlCBhIGBRdWVyeWAgb25cbiAgICogR1NJMiAocGVyLWdyb3VwIHdpbmRvd2VkIHJlcG9ydCkgYW5kIGEgYFNjYW5gICh0aGUgZ3JvdXAgcGlja2VyKS4gTm9cbiAgICogQ2xvdWRXYXRjaC9wcmljaW5nL29taWNzIGdyYW50cyBhcmUgbmVlZGVkIGJlY2F1c2UgdGhlIFJ1bl9TdW1tYXJ5IHJvbGx1cHNcbiAgICogYXJlIHByZS1jb21wdXRlZCBhdCBpbmdlc3QgdGltZTsgdGhlIHJlcG9ydCBpcyBhIHB1cmUgcmVhZC1hbmQtYWdncmVnYXRlLlxuICAgKi9cbiAgcHJpdmF0ZSBhZGRSZXBvcnRzUmVzb2x2ZXIoXG4gICAgdGFibGU6IERhdGFTdGFja1sndGFibGUnXSxcbiAgICBnc2kyTmFtZTogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCByZXBvcnRzRm4gPSBuZXcgTm9kZWpzRnVuY3Rpb24odGhpcywgJ1JlcG9ydHNGdW5jdGlvbicsIHtcbiAgICAgIHJ1bnRpbWU6IFJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBlbnRyeTogUkVQT1JUU19IQU5ETEVSX0VOVFJZLFxuICAgICAgaGFuZGxlcjogJ2hhbmRsZXInLFxuICAgICAgcHJvamVjdFJvb3Q6IElOR0VTVF9QUk9KRUNUX1JPT1QsXG4gICAgICBkZXBzTG9ja0ZpbGVQYXRoOiBJTkdFU1RfREVQU19MT0NLX0ZJTEUsXG4gICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFJFUE9SVFNfUkVHSU9OOiBTdGFjay5vZih0aGlzKS5yZWdpb24sXG4gICAgICAgIFJFUE9SVFNfVEFCTEVfTkFNRTogdGFibGUudGFibGVOYW1lLFxuICAgICAgICBSRVBPUlRTX0dTSTJfTkFNRTogZ3NpMk5hbWUsXG4gICAgICB9LFxuICAgICAgYnVuZGxpbmc6IHtcbiAgICAgICAgZm9ybWF0OiBPdXRwdXRGb3JtYXQuRVNNLFxuICAgICAgICBleHRlcm5hbE1vZHVsZXM6IFsnQGF3cy1zZGsvKiddLFxuICAgICAgICBiYW5uZXI6XG4gICAgICAgICAgXCJpbXBvcnR7Y3JlYXRlUmVxdWlyZSBhcyBfX2NyZWF0ZVJlcXVpcmV9ZnJvbSdtb2R1bGUnO2NvbnN0IHJlcXVpcmU9X19jcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XCIsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gUmVhZC1vbmx5IER5bmFtb0RCIGFjY2VzcyBzY29wZWQgdG8gdGhlIHRhYmxlIChhbmQgaXRzIGluZGV4ZXMsIHdoaWNoXG4gICAgLy8gYGdyYW50YCBjb3ZlcnMgdmlhIHRoZSB0YWJsZSBBUk4gKyBgL2luZGV4LypgKS4gUXVlcnkgYmFja3MgdGhlIHBlci1ncm91cFxuICAgIC8vIEdTSTIgcmVwb3J0OyBTY2FuIGJhY2tzIHRoZSBncm91cCBwaWNrZXIuIE5vIHdyaXRlIGFjdGlvbnMuXG4gICAgdGFibGUuZ3JhbnQocmVwb3J0c0ZuLCAnZHluYW1vZGI6UXVlcnknLCAnZHluYW1vZGI6U2NhbicpO1xuXG4gICAgY29uc3QgcmVwb3J0c0RhdGFTb3VyY2UgPSB0aGlzLmFwaS5hZGRMYW1iZGFEYXRhU291cmNlKFxuICAgICAgJ1JlcG9ydHNEYXRhU291cmNlJyxcbiAgICAgIHJlcG9ydHNGbixcbiAgICApO1xuXG4gICAgcmVwb3J0c0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2xpc3RXb3JrZmxvd0dyb3Vwc1Jlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdsaXN0V29ya2Zsb3dHcm91cHMnLFxuICAgIH0pO1xuICAgIHJlcG9ydHNEYXRhU291cmNlLmNyZWF0ZVJlc29sdmVyKCdnZXRXb3JrZmxvd1JlcG9ydFJlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdnZXRXb3JrZmxvd1JlcG9ydCcsXG4gICAgfSk7XG4gICAgcmVwb3J0c0RhdGFTb3VyY2UuY3JlYXRlUmVzb2x2ZXIoJ2xpc3RXb3JrZmxvd1J1blBvaW50c1Jlc29sdmVyJywge1xuICAgICAgdHlwZU5hbWU6ICdRdWVyeScsXG4gICAgICBmaWVsZE5hbWU6ICdsaXN0V29ya2Zsb3dSdW5Qb2ludHMnLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFN0YWNrIG91dHB1dHMgY29uc3VtZWQgYnkgdGhlIGZyb250ZW5kIGJ1aWxkICh0YXNrIDEyLjEpLlxuICAgKlxuICAgKiBUaGUgQXBwU3luYyBHcmFwaFFMIGVuZHBvaW50IFVSTCwgQ29nbml0byB1c2VyIHBvb2wgSUQsIGFwcCBjbGllbnQgSUQsIGFuZFxuICAgKiByZWdpb24gYXJlIGVtaXR0ZWQgd2l0aCBleHBvcnQgbmFtZXMgc28gdGhlIFZpdGUgYnVpbGQgY2FuIGluamVjdCB0aGVtIGF0XG4gICAqIGJ1aWxkIHRpbWUgYW5kIHRoZSBTUEEgY2FycmllcyBubyBoYXJkY29kZWQgZW52aXJvbm1lbnQgdmFsdWVzIChSZXEgMTEuNykuXG4gICAqL1xuICBwcml2YXRlIGFkZE91dHB1dHMoKTogdm9pZCB7XG4gICAgY29uc3Qgb3V0cHV0czogUmVhZG9ubHlBcnJheTx7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgdmFsdWU6IHN0cmluZztcbiAgICAgIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gICAgfT4gPSBbXG4gICAgICB7XG4gICAgICAgIGlkOiAnR3JhcGhxbEFwaVVybCcsXG4gICAgICAgIHZhbHVlOiB0aGlzLmFwaS5ncmFwaHFsVXJsLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ0FwcFN5bmMgR3JhcGhRTCBlbmRwb2ludCBVUkwuJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnVXNlclBvb2xJZCcsXG4gICAgICAgIHZhbHVlOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byB1c2VyIHBvb2wgSUQuJyxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAnVXNlclBvb2xDbGllbnRJZCcsXG4gICAgICAgIHZhbHVlOiB0aGlzLnVzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWQsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnQ29nbml0byBhcHAgY2xpZW50IElEIGZvciB0aGUgU1BBLicsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ1JlZ2lvbicsXG4gICAgICAgIHZhbHVlOiB0aGlzLnJlZ2lvbixcbiAgICAgICAgZGVzY3JpcHRpb246ICdBV1MgcmVnaW9uIHRoZSBBUEkgaXMgZGVwbG95ZWQgaW4uJyxcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGZvciAoY29uc3QgeyBpZCwgdmFsdWUsIGRlc2NyaXB0aW9uIH0gb2Ygb3V0cHV0cykge1xuICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCBpZCwge1xuICAgICAgICB2YWx1ZSxcbiAgICAgICAgZGVzY3JpcHRpb24sXG4gICAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS0ke2lkfWAsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQVBQU1lOQ19KUyByZWFkIHJlc29sdmVycyBvbiB0aGUgRHluYW1vREIgZGF0YSBzb3VyY2UuXG4gICAqXG4gICAqIC0gbGlzdFJ1bnM6IFF1ZXJ5IEdTSTEgKEdTSTFQSyA9ICdSVU5TJykgZGVzY2VuZGluZyBieSB1cGRhdGVkQXQgd2l0aFxuICAgKiAgIHNlcnZlci1zaWRlIGxpbWl0IHZhbGlkYXRpb24gKDHigJMxMDAsIGRlZmF1bHQgMjUpIGFuZCBuZXh0VG9rZW5cbiAgICogICBwYWdpbmF0aW9uOyBvdXQtb2YtcmFuZ2UgbGltaXRzIGFuZCBtYWxmb3JtZWQvZXhwaXJlZCB0b2tlbnMgYXJlIHJlamVjdGVkXG4gICAqICAgKFJlcSA1LjIsIDUuMywgNS40LCA1LjUpLlxuICAgKiAtIGdldFJ1bjogR2V0SXRlbSBQSyA9IFNLID0gJ1JVTiM8cnVuSWQ+JzsgbnVsbCAobm8gZXJyb3IpIHdoZW4gYWJzZW50XG4gICAqICAgKFJlcSA1LjYsIDUuNykuXG4gICAqIC0gbGlzdFRhc2tzRm9yUnVuOiBRdWVyeSBQSyA9ICdSVU4jPHJ1bklkPicsIFNLIGJlZ2luc193aXRoICdUQVNLIyc7XG4gICAqICAgcmV0dXJucyBpdGVtcyBvciBhbiBlbXB0eSBsaXN0IChSZXEgNS44KS5cbiAgICogLSBnZXRTdGF0aWNHcmFwaDogR2V0SXRlbSBQSyA9IFNLID0gJ1dGIzx3b3JrZmxvd0lkPiM8d29ya2Zsb3dWZXJzaW9uTmFtZT4nO1xuICAgKiAgIG51bGwgKG5vIGVycm9yKSB3aGVuIGFic2VudCBvciBhIGZhaWx1cmUtb25seSBtYXJrZXIgKFJlcSA2LjYpLiBHZXRJdGVtXG4gICAqICAgb25seSwgd2l0aGluIHRoZSBleGlzdGluZyByZWFkLW9ubHkgZ3JhbnQg4oCUIG5vIG5ldyBkYXRhIHNvdXJjZS9JQU0uXG4gICAqL1xuICBwcml2YXRlIGFkZFJlYWRSZXNvbHZlcnMoZGF0YVNvdXJjZTogRHluYW1vRGJEYXRhU291cmNlKTogdm9pZCB7XG4gICAgY29uc3QgcmVhZHM6IFJlYWRvbmx5QXJyYXk8eyBmaWVsZDogc3RyaW5nOyBmaWxlOiBzdHJpbmcgfT4gPSBbXG4gICAgICB7IGZpZWxkOiAnbGlzdFJ1bnMnLCBmaWxlOiAnbGlzdFJ1bnMuanMnIH0sXG4gICAgICB7IGZpZWxkOiAnZ2V0UnVuJywgZmlsZTogJ2dldFJ1bi5qcycgfSxcbiAgICAgIHsgZmllbGQ6ICdsaXN0VGFza3NGb3JSdW4nLCBmaWxlOiAnbGlzdFRhc2tzRm9yUnVuLmpzJyB9LFxuICAgICAgeyBmaWVsZDogJ2dldFN0YXRpY0dyYXBoJywgZmlsZTogJ2dldFN0YXRpY0dyYXBoLmpzJyB9LFxuICAgIF07XG5cbiAgICBmb3IgKGNvbnN0IHsgZmllbGQsIGZpbGUgfSBvZiByZWFkcykge1xuICAgICAgbmV3IFJlc29sdmVyKHRoaXMsIGAke2ZpZWxkfVJlc29sdmVyYCwge1xuICAgICAgICBhcGk6IHRoaXMuYXBpLFxuICAgICAgICB0eXBlTmFtZTogJ1F1ZXJ5JyxcbiAgICAgICAgZmllbGROYW1lOiBmaWVsZCxcbiAgICAgICAgZGF0YVNvdXJjZSxcbiAgICAgICAgcnVudGltZTogRnVuY3Rpb25SdW50aW1lLkpTXzFfMF8wLFxuICAgICAgICBjb2RlOiBDb2RlLmZyb21Bc3NldChyZXNvbHZlclBhdGgoZmlsZSkpLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFBhc3MtdGhyb3VnaCByZXNvbHZlcnMgZm9yIHRoZSBJQU0tYXV0aG9yaXplZCBwdWJsaXNoIG11dGF0aW9ucy5cbiAgICpcbiAgICogcHVibGlzaFJ1blVwZGF0ZSAvIHB1Ymxpc2hUYXNrVXBkYXRlIGNhcnJ5IG5vIGRhdGEtc291cmNlIHdvcms6IHRoZXkgZWNob1xuICAgKiB0aGVpciBpbnB1dCBvbiBhIE5PTkUgKGxvY2FsKSBkYXRhIHNvdXJjZSBzbyBAYXdzX3N1YnNjcmliZSBmYW5zIHRoZVxuICAgKiBwYXlsb2FkIG91dCB0byBvblJ1blVwZGF0ZWQgLyBvblRhc2tVcGRhdGVkIHN1YnNjcmliZXJzIChSZXEgNC41LCA0LjYpLiBUaGVcbiAgICogaW5nZXN0IExhbWJkYSBoYXMgYWxyZWFkeSBwZXJzaXN0ZWQgdGhlIHJ1bi90YXNrIGJlZm9yZSBjYWxsaW5nIHRoZW0uXG4gICAqL1xuICBwcml2YXRlIGFkZFB1Ymxpc2hSZXNvbHZlcnMoKTogdm9pZCB7XG4gICAgY29uc3Qgbm9uZURhdGFTb3VyY2UgPSB0aGlzLmFwaS5hZGROb25lRGF0YVNvdXJjZSgnUHVibGlzaE5vbmVEYXRhU291cmNlJyk7XG5cbiAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIFsncHVibGlzaFJ1blVwZGF0ZScsICdwdWJsaXNoVGFza1VwZGF0ZSddKSB7XG4gICAgICBuZXcgUmVzb2x2ZXIodGhpcywgYCR7ZmllbGR9UmVzb2x2ZXJgLCB7XG4gICAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICAgIHR5cGVOYW1lOiAnTXV0YXRpb24nLFxuICAgICAgICBmaWVsZE5hbWU6IGZpZWxkLFxuICAgICAgICBkYXRhU291cmNlOiBub25lRGF0YVNvdXJjZSxcbiAgICAgICAgcnVudGltZTogRnVuY3Rpb25SdW50aW1lLkpTXzFfMF8wLFxuICAgICAgICBjb2RlOiBDb2RlLmZyb21Bc3NldChyZXNvbHZlclBhdGgoJ3B1Ymxpc2hQYXNzdGhyb3VnaC5qcycpKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuIl19