"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_dynamodb_1 = require("aws-cdk-lib/aws-dynamodb");
/** Name of the recency-ordered global secondary index (Req 3.7). */
const GSI1_INDEX_NAME = 'GSI1';
/**
 * Name of the Workflow_Group index for aggregate reports
 * (workflow-performance-reports Req 2.2). Run_Summary items are indexed by
 * `GSI2PK = WF#<name>#<version>` and `GSI2SK = <terminal timestamp>` so a
 * report is a single time-ordered range query per group.
 */
const GSI2_INDEX_NAME = 'GSI2';
/**
 * DataStack — the stateful layer.
 *
 * Owns the DynamoDB single table (on-demand, PITR, GSI1) that holds run, task,
 * and workflow-graph items. Isolated from the frequently-changing API, ingest,
 * and frontend stacks so its removal policy and blast radius stay independent.
 *
 * Single-table design (design.md "DynamoDB single-table design"):
 *   Primary key: PK (partition), SK (sort).
 *   GSI1:        GSI1PK (partition), GSI1SK (sort) — all runs ordered by recency.
 *
 * Requirements: 3.6 (on-demand + PITR), 3.7 (GSI1 on GSI1PK/GSI1SK),
 * 12.3 (on-demand capacity, no provisioned throughput), 11.7 (stack outputs).
 */
class DataStack extends aws_cdk_lib_1.Stack {
    /** The single DynamoDB table holding run, task, and graph items. */
    table;
    /** Name of the single table, exported for downstream stacks and the frontend build. */
    tableName;
    /** ARN of the single table. */
    tableArn;
    /** ARN of the GSI1 recency index (table ARN + `/index/GSI1`). */
    gsi1Arn;
    /** Name of the recency-ordered global secondary index. */
    gsi1Name = GSI1_INDEX_NAME;
    /** ARN of the GSI2 Workflow_Group index (table ARN + `/index/GSI2`). */
    gsi2Arn;
    /** Name of the Workflow_Group index used by aggregate reports. */
    gsi2Name = GSI2_INDEX_NAME;
    constructor(scope, id, props) {
        super(scope, id, props);
        // Single table, on-demand (PAY_PER_REQUEST) capacity with point-in-time
        // recovery enabled (Req 3.6, 12.3). RemovalPolicy.DESTROY so `cdk destroy`
        // tears the table down cleanly with no orphaned resources (Req 11.9); this
        // is a demo/dashboard store, not a system of record.
        this.table = new aws_dynamodb_1.Table(this, 'Table', {
            partitionKey: { name: 'PK', type: aws_dynamodb_1.AttributeType.STRING },
            sortKey: { name: 'SK', type: aws_dynamodb_1.AttributeType.STRING },
            billingMode: aws_dynamodb_1.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            encryption: aws_dynamodb_1.TableEncryption.AWS_MANAGED,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
        });
        // GSI1 supports listing all runs ordered by `updatedAt` recency (Req 3.7).
        // ALL projection so the fleet list can render each run without a follow-up
        // GetItem. On-demand capacity is inherited from the table's billing mode.
        this.table.addGlobalSecondaryIndex({
            indexName: GSI1_INDEX_NAME,
            partitionKey: { name: 'GSI1PK', type: aws_dynamodb_1.AttributeType.STRING },
            sortKey: { name: 'GSI1SK', type: aws_dynamodb_1.AttributeType.STRING },
            projectionType: aws_dynamodb_1.ProjectionType.ALL,
        });
        // GSI2 supports the aggregate Reports feature: all Run_Summary rows for one
        // Workflow_Group (`GSI2PK = WF#<name>#<version>`) ordered by terminal
        // timestamp (`GSI2SK`), so a windowed report is a single range query per
        // group (workflow-performance-reports Req 2.2). ALL projection so the
        // Reports Lambda can aggregate every summary attribute without a follow-up
        // GetItem. On-demand capacity is inherited from the table's billing mode.
        this.table.addGlobalSecondaryIndex({
            indexName: GSI2_INDEX_NAME,
            partitionKey: { name: 'GSI2PK', type: aws_dynamodb_1.AttributeType.STRING },
            sortKey: { name: 'GSI2SK', type: aws_dynamodb_1.AttributeType.STRING },
            projectionType: aws_dynamodb_1.ProjectionType.ALL,
        });
        this.tableName = this.table.tableName;
        this.tableArn = this.table.tableArn;
        this.gsi1Arn = `${this.table.tableArn}/index/${GSI1_INDEX_NAME}`;
        this.gsi2Arn = `${this.table.tableArn}/index/${GSI2_INDEX_NAME}`;
        // Stack outputs: resource names and ARNs are exposed for downstream stacks
        // and injection into the frontend build configuration (Req 11.7).
        new aws_cdk_lib_1.CfnOutput(this, 'TableName', {
            value: this.tableName,
            description: 'Name of the DynamoDB single table.',
            exportName: `${this.stackName}-TableName`,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'TableArn', {
            value: this.tableArn,
            description: 'ARN of the DynamoDB single table.',
            exportName: `${this.stackName}-TableArn`,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'Gsi1Arn', {
            value: this.gsi1Arn,
            description: 'ARN of the GSI1 recency-ordered global secondary index.',
            exportName: `${this.stackName}-Gsi1Arn`,
        });
        new aws_cdk_lib_1.CfnOutput(this, 'Gsi2Arn', {
            value: this.gsi2Arn,
            description: 'ARN of the GSI2 Workflow_Group index used by aggregate reports.',
            exportName: `${this.stackName}-Gsi2Arn`,
        });
    }
}
exports.DataStack = DataStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGF0YS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImRhdGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsNkNBQTBFO0FBQzFFLDJEQU1rQztBQUdsQyxvRUFBb0U7QUFDcEUsTUFBTSxlQUFlLEdBQUcsTUFBTSxDQUFDO0FBRS9COzs7OztHQUtHO0FBQ0gsTUFBTSxlQUFlLEdBQUcsTUFBTSxDQUFDO0FBRS9COzs7Ozs7Ozs7Ozs7O0dBYUc7QUFDSCxNQUFhLFNBQVUsU0FBUSxtQkFBSztJQUNsQyxvRUFBb0U7SUFDcEQsS0FBSyxDQUFRO0lBRTdCLHVGQUF1RjtJQUN2RSxTQUFTLENBQVM7SUFFbEMsK0JBQStCO0lBQ2YsUUFBUSxDQUFTO0lBRWpDLGlFQUFpRTtJQUNqRCxPQUFPLENBQVM7SUFFaEMsMERBQTBEO0lBQzFDLFFBQVEsR0FBVyxlQUFlLENBQUM7SUFFbkQsd0VBQXdFO0lBQ3hELE9BQU8sQ0FBUztJQUVoQyxrRUFBa0U7SUFDbEQsUUFBUSxHQUFXLGVBQWUsQ0FBQztJQUVuRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWtCO1FBQzFELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLHdFQUF3RTtRQUN4RSwyRUFBMkU7UUFDM0UsMkVBQTJFO1FBQzNFLHFEQUFxRDtRQUNyRCxJQUFJLENBQUMsS0FBSyxHQUFHLElBQUksb0JBQUssQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO1lBQ3BDLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLDRCQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3hELE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLDRCQUFhLENBQUMsTUFBTSxFQUFFO1lBQ25ELFdBQVcsRUFBRSwwQkFBVyxDQUFDLGVBQWU7WUFDeEMsbUJBQW1CLEVBQUUsSUFBSTtZQUN6QixVQUFVLEVBQUUsOEJBQWUsQ0FBQyxXQUFXO1lBQ3ZDLGFBQWEsRUFBRSwyQkFBYSxDQUFDLE9BQU87U0FDckMsQ0FBQyxDQUFDO1FBRUgsMkVBQTJFO1FBQzNFLDJFQUEyRTtRQUMzRSwwRUFBMEU7UUFDMUUsSUFBSSxDQUFDLEtBQUssQ0FBQyx1QkFBdUIsQ0FBQztZQUNqQyxTQUFTLEVBQUUsZUFBZTtZQUMxQixZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSw0QkFBYSxDQUFDLE1BQU0sRUFBRTtZQUM1RCxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSw0QkFBYSxDQUFDLE1BQU0sRUFBRTtZQUN2RCxjQUFjLEVBQUUsNkJBQWMsQ0FBQyxHQUFHO1NBQ25DLENBQUMsQ0FBQztRQUVILDRFQUE0RTtRQUM1RSxzRUFBc0U7UUFDdEUseUVBQXlFO1FBQ3pFLHNFQUFzRTtRQUN0RSwyRUFBMkU7UUFDM0UsMEVBQTBFO1FBQzFFLElBQUksQ0FBQyxLQUFLLENBQUMsdUJBQXVCLENBQUM7WUFDakMsU0FBUyxFQUFFLGVBQWU7WUFDMUIsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsNEJBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDNUQsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsNEJBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDdkQsY0FBYyxFQUFFLDZCQUFjLENBQUMsR0FBRztTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDO1FBQ3RDLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUM7UUFDcEMsSUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxVQUFVLGVBQWUsRUFBRSxDQUFDO1FBQ2pFLElBQUksQ0FBQyxPQUFPLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsVUFBVSxlQUFlLEVBQUUsQ0FBQztRQUVqRSwyRUFBMkU7UUFDM0Usa0VBQWtFO1FBQ2xFLElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO1lBQy9CLEtBQUssRUFBRSxJQUFJLENBQUMsU0FBUztZQUNyQixXQUFXLEVBQUUsb0NBQW9DO1lBQ2pELFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLFlBQVk7U0FDMUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDOUIsS0FBSyxFQUFFLElBQUksQ0FBQyxRQUFRO1lBQ3BCLFdBQVcsRUFBRSxtQ0FBbUM7WUFDaEQsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsV0FBVztTQUN6QyxDQUFDLENBQUM7UUFFSCxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUM3QixLQUFLLEVBQUUsSUFBSSxDQUFDLE9BQU87WUFDbkIsV0FBVyxFQUFFLHlEQUF5RDtZQUN0RSxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxVQUFVO1NBQ3hDLENBQUMsQ0FBQztRQUVILElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQzdCLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTztZQUNuQixXQUFXLEVBQUUsaUVBQWlFO1lBQzlFLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLFVBQVU7U0FDeEMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBNUZELDhCQTRGQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmbk91dHB1dCwgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFN0YWNrUHJvcHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQge1xuICBBdHRyaWJ1dGVUeXBlLFxuICBCaWxsaW5nTW9kZSxcbiAgUHJvamVjdGlvblR5cGUsXG4gIFRhYmxlLFxuICBUYWJsZUVuY3J5cHRpb24sXG59IGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuLyoqIE5hbWUgb2YgdGhlIHJlY2VuY3ktb3JkZXJlZCBnbG9iYWwgc2Vjb25kYXJ5IGluZGV4IChSZXEgMy43KS4gKi9cbmNvbnN0IEdTSTFfSU5ERVhfTkFNRSA9ICdHU0kxJztcblxuLyoqXG4gKiBOYW1lIG9mIHRoZSBXb3JrZmxvd19Hcm91cCBpbmRleCBmb3IgYWdncmVnYXRlIHJlcG9ydHNcbiAqICh3b3JrZmxvdy1wZXJmb3JtYW5jZS1yZXBvcnRzIFJlcSAyLjIpLiBSdW5fU3VtbWFyeSBpdGVtcyBhcmUgaW5kZXhlZCBieVxuICogYEdTSTJQSyA9IFdGIzxuYW1lPiM8dmVyc2lvbj5gIGFuZCBgR1NJMlNLID0gPHRlcm1pbmFsIHRpbWVzdGFtcD5gIHNvIGFcbiAqIHJlcG9ydCBpcyBhIHNpbmdsZSB0aW1lLW9yZGVyZWQgcmFuZ2UgcXVlcnkgcGVyIGdyb3VwLlxuICovXG5jb25zdCBHU0kyX0lOREVYX05BTUUgPSAnR1NJMic7XG5cbi8qKlxuICogRGF0YVN0YWNrIOKAlCB0aGUgc3RhdGVmdWwgbGF5ZXIuXG4gKlxuICogT3ducyB0aGUgRHluYW1vREIgc2luZ2xlIHRhYmxlIChvbi1kZW1hbmQsIFBJVFIsIEdTSTEpIHRoYXQgaG9sZHMgcnVuLCB0YXNrLFxuICogYW5kIHdvcmtmbG93LWdyYXBoIGl0ZW1zLiBJc29sYXRlZCBmcm9tIHRoZSBmcmVxdWVudGx5LWNoYW5naW5nIEFQSSwgaW5nZXN0LFxuICogYW5kIGZyb250ZW5kIHN0YWNrcyBzbyBpdHMgcmVtb3ZhbCBwb2xpY3kgYW5kIGJsYXN0IHJhZGl1cyBzdGF5IGluZGVwZW5kZW50LlxuICpcbiAqIFNpbmdsZS10YWJsZSBkZXNpZ24gKGRlc2lnbi5tZCBcIkR5bmFtb0RCIHNpbmdsZS10YWJsZSBkZXNpZ25cIik6XG4gKiAgIFByaW1hcnkga2V5OiBQSyAocGFydGl0aW9uKSwgU0sgKHNvcnQpLlxuICogICBHU0kxOiAgICAgICAgR1NJMVBLIChwYXJ0aXRpb24pLCBHU0kxU0sgKHNvcnQpIOKAlCBhbGwgcnVucyBvcmRlcmVkIGJ5IHJlY2VuY3kuXG4gKlxuICogUmVxdWlyZW1lbnRzOiAzLjYgKG9uLWRlbWFuZCArIFBJVFIpLCAzLjcgKEdTSTEgb24gR1NJMVBLL0dTSTFTSyksXG4gKiAxMi4zIChvbi1kZW1hbmQgY2FwYWNpdHksIG5vIHByb3Zpc2lvbmVkIHRocm91Z2hwdXQpLCAxMS43IChzdGFjayBvdXRwdXRzKS5cbiAqL1xuZXhwb3J0IGNsYXNzIERhdGFTdGFjayBleHRlbmRzIFN0YWNrIHtcbiAgLyoqIFRoZSBzaW5nbGUgRHluYW1vREIgdGFibGUgaG9sZGluZyBydW4sIHRhc2ssIGFuZCBncmFwaCBpdGVtcy4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlOiBUYWJsZTtcblxuICAvKiogTmFtZSBvZiB0aGUgc2luZ2xlIHRhYmxlLCBleHBvcnRlZCBmb3IgZG93bnN0cmVhbSBzdGFja3MgYW5kIHRoZSBmcm9udGVuZCBidWlsZC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlTmFtZTogc3RyaW5nO1xuXG4gIC8qKiBBUk4gb2YgdGhlIHNpbmdsZSB0YWJsZS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IHRhYmxlQXJuOiBzdHJpbmc7XG5cbiAgLyoqIEFSTiBvZiB0aGUgR1NJMSByZWNlbmN5IGluZGV4ICh0YWJsZSBBUk4gKyBgL2luZGV4L0dTSTFgKS4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGdzaTFBcm46IHN0cmluZztcblxuICAvKiogTmFtZSBvZiB0aGUgcmVjZW5jeS1vcmRlcmVkIGdsb2JhbCBzZWNvbmRhcnkgaW5kZXguICovXG4gIHB1YmxpYyByZWFkb25seSBnc2kxTmFtZTogc3RyaW5nID0gR1NJMV9JTkRFWF9OQU1FO1xuXG4gIC8qKiBBUk4gb2YgdGhlIEdTSTIgV29ya2Zsb3dfR3JvdXAgaW5kZXggKHRhYmxlIEFSTiArIGAvaW5kZXgvR1NJMmApLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZ3NpMkFybjogc3RyaW5nO1xuXG4gIC8qKiBOYW1lIG9mIHRoZSBXb3JrZmxvd19Hcm91cCBpbmRleCB1c2VkIGJ5IGFnZ3JlZ2F0ZSByZXBvcnRzLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZ3NpMk5hbWU6IHN0cmluZyA9IEdTSTJfSU5ERVhfTkFNRTtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IFN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFNpbmdsZSB0YWJsZSwgb24tZGVtYW5kIChQQVlfUEVSX1JFUVVFU1QpIGNhcGFjaXR5IHdpdGggcG9pbnQtaW4tdGltZVxuICAgIC8vIHJlY292ZXJ5IGVuYWJsZWQgKFJlcSAzLjYsIDEyLjMpLiBSZW1vdmFsUG9saWN5LkRFU1RST1kgc28gYGNkayBkZXN0cm95YFxuICAgIC8vIHRlYXJzIHRoZSB0YWJsZSBkb3duIGNsZWFubHkgd2l0aCBubyBvcnBoYW5lZCByZXNvdXJjZXMgKFJlcSAxMS45KTsgdGhpc1xuICAgIC8vIGlzIGEgZGVtby9kYXNoYm9hcmQgc3RvcmUsIG5vdCBhIHN5c3RlbSBvZiByZWNvcmQuXG4gICAgdGhpcy50YWJsZSA9IG5ldyBUYWJsZSh0aGlzLCAnVGFibGUnLCB7XG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogJ1BLJywgdHlwZTogQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ1NLJywgdHlwZTogQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBCaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5OiB0cnVlLFxuICAgICAgZW5jcnlwdGlvbjogVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgcmVtb3ZhbFBvbGljeTogUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gR1NJMSBzdXBwb3J0cyBsaXN0aW5nIGFsbCBydW5zIG9yZGVyZWQgYnkgYHVwZGF0ZWRBdGAgcmVjZW5jeSAoUmVxIDMuNykuXG4gICAgLy8gQUxMIHByb2plY3Rpb24gc28gdGhlIGZsZWV0IGxpc3QgY2FuIHJlbmRlciBlYWNoIHJ1biB3aXRob3V0IGEgZm9sbG93LXVwXG4gICAgLy8gR2V0SXRlbS4gT24tZGVtYW5kIGNhcGFjaXR5IGlzIGluaGVyaXRlZCBmcm9tIHRoZSB0YWJsZSdzIGJpbGxpbmcgbW9kZS5cbiAgICB0aGlzLnRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogR1NJMV9JTkRFWF9OQU1FLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdHU0kxUEsnLCB0eXBlOiBBdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiAnR1NJMVNLJywgdHlwZTogQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBQcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICAvLyBHU0kyIHN1cHBvcnRzIHRoZSBhZ2dyZWdhdGUgUmVwb3J0cyBmZWF0dXJlOiBhbGwgUnVuX1N1bW1hcnkgcm93cyBmb3Igb25lXG4gICAgLy8gV29ya2Zsb3dfR3JvdXAgKGBHU0kyUEsgPSBXRiM8bmFtZT4jPHZlcnNpb24+YCkgb3JkZXJlZCBieSB0ZXJtaW5hbFxuICAgIC8vIHRpbWVzdGFtcCAoYEdTSTJTS2ApLCBzbyBhIHdpbmRvd2VkIHJlcG9ydCBpcyBhIHNpbmdsZSByYW5nZSBxdWVyeSBwZXJcbiAgICAvLyBncm91cCAod29ya2Zsb3ctcGVyZm9ybWFuY2UtcmVwb3J0cyBSZXEgMi4yKS4gQUxMIHByb2plY3Rpb24gc28gdGhlXG4gICAgLy8gUmVwb3J0cyBMYW1iZGEgY2FuIGFnZ3JlZ2F0ZSBldmVyeSBzdW1tYXJ5IGF0dHJpYnV0ZSB3aXRob3V0IGEgZm9sbG93LXVwXG4gICAgLy8gR2V0SXRlbS4gT24tZGVtYW5kIGNhcGFjaXR5IGlzIGluaGVyaXRlZCBmcm9tIHRoZSB0YWJsZSdzIGJpbGxpbmcgbW9kZS5cbiAgICB0aGlzLnRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcbiAgICAgIGluZGV4TmFtZTogR1NJMl9JTkRFWF9OQU1FLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdHU0kyUEsnLCB0eXBlOiBBdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiAnR1NJMlNLJywgdHlwZTogQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHByb2plY3Rpb25UeXBlOiBQcm9qZWN0aW9uVHlwZS5BTEwsXG4gICAgfSk7XG5cbiAgICB0aGlzLnRhYmxlTmFtZSA9IHRoaXMudGFibGUudGFibGVOYW1lO1xuICAgIHRoaXMudGFibGVBcm4gPSB0aGlzLnRhYmxlLnRhYmxlQXJuO1xuICAgIHRoaXMuZ3NpMUFybiA9IGAke3RoaXMudGFibGUudGFibGVBcm59L2luZGV4LyR7R1NJMV9JTkRFWF9OQU1FfWA7XG4gICAgdGhpcy5nc2kyQXJuID0gYCR7dGhpcy50YWJsZS50YWJsZUFybn0vaW5kZXgvJHtHU0kyX0lOREVYX05BTUV9YDtcblxuICAgIC8vIFN0YWNrIG91dHB1dHM6IHJlc291cmNlIG5hbWVzIGFuZCBBUk5zIGFyZSBleHBvc2VkIGZvciBkb3duc3RyZWFtIHN0YWNrc1xuICAgIC8vIGFuZCBpbmplY3Rpb24gaW50byB0aGUgZnJvbnRlbmQgYnVpbGQgY29uZmlndXJhdGlvbiAoUmVxIDExLjcpLlxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ1RhYmxlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTmFtZSBvZiB0aGUgRHluYW1vREIgc2luZ2xlIHRhYmxlLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFibGVOYW1lYCxcbiAgICB9KTtcblxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ1RhYmxlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFibGVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FSTiBvZiB0aGUgRHluYW1vREIgc2luZ2xlIHRhYmxlLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tVGFibGVBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnR3NpMUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmdzaTFBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FSTiBvZiB0aGUgR1NJMSByZWNlbmN5LW9yZGVyZWQgZ2xvYmFsIHNlY29uZGFyeSBpbmRleC4nLFxuICAgICAgZXhwb3J0TmFtZTogYCR7dGhpcy5zdGFja05hbWV9LUdzaTFBcm5gLFxuICAgIH0pO1xuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnR3NpMkFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmdzaTJBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FSTiBvZiB0aGUgR1NJMiBXb3JrZmxvd19Hcm91cCBpbmRleCB1c2VkIGJ5IGFnZ3JlZ2F0ZSByZXBvcnRzLicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tR3NpMkFybmAsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==