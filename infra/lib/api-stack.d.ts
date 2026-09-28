import { Stack, StackProps } from 'aws-cdk-lib';
import { GraphqlApi } from 'aws-cdk-lib/aws-appsync';
import { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { DataStack } from './data-stack';
export interface ApiStackProps extends StackProps {
    /** The data layer this API reads from. Establishes deploy ordering. */
    readonly dataStack: DataStack;
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
export declare class ApiStack extends Stack {
    /** The AppSync GraphQL API. */
    readonly api: GraphqlApi;
    /** The Cognito user pool guarding interactive access to the API. */
    readonly userPool: UserPool;
    /** The Cognito app client the SPA authenticates against. */
    readonly userPoolClient: UserPoolClient;
    constructor(scope: Construct, id: string, props: ApiStackProps);
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
    private addLogsResolver;
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
    private addMetricsResolver;
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
    private addCostResolver;
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
    private addReportsResolver;
    /**
     * Stack outputs consumed by the frontend build (task 12.1).
     *
     * The AppSync GraphQL endpoint URL, Cognito user pool ID, app client ID, and
     * region are emitted with export names so the Vite build can inject them at
     * build time and the SPA carries no hardcoded environment values (Req 11.7).
     */
    private addOutputs;
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
    private addReadResolvers;
    /**
     * Pass-through resolvers for the IAM-authorized publish mutations.
     *
     * publishRunUpdate / publishTaskUpdate carry no data-source work: they echo
     * their input on a NONE (local) data source so @aws_subscribe fans the
     * payload out to onRunUpdated / onTaskUpdated subscribers (Req 4.5, 4.6). The
     * ingest Lambda has already persisted the run/task before calling them.
     */
    private addPublishResolvers;
}
