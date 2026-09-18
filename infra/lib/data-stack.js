"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_dynamodb_1 = require("aws-cdk-lib/aws-dynamodb");
/** Name of the recency-ordered global secondary index (Req 3.7). */
const GSI1_INDEX_NAME = 'GSI1';
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
        this.tableName = this.table.tableName;
        this.tableArn = this.table.tableArn;
        this.gsi1Arn = `${this.table.tableArn}/index/${GSI1_INDEX_NAME}`;
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
    }
}
exports.DataStack = DataStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGF0YS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImRhdGEtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsNkNBQTBFO0FBQzFFLDJEQU1rQztBQUdsQyxvRUFBb0U7QUFDcEUsTUFBTSxlQUFlLEdBQUcsTUFBTSxDQUFDO0FBRS9COzs7Ozs7Ozs7Ozs7O0dBYUc7QUFDSCxNQUFhLFNBQVUsU0FBUSxtQkFBSztJQUNsQyxvRUFBb0U7SUFDcEQsS0FBSyxDQUFRO0lBRTdCLHVGQUF1RjtJQUN2RSxTQUFTLENBQVM7SUFFbEMsK0JBQStCO0lBQ2YsUUFBUSxDQUFTO0lBRWpDLGlFQUFpRTtJQUNqRCxPQUFPLENBQVM7SUFFaEMsMERBQTBEO0lBQzFDLFFBQVEsR0FBVyxlQUFlLENBQUM7SUFFbkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFrQjtRQUMxRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qix3RUFBd0U7UUFDeEUsMkVBQTJFO1FBQzNFLDJFQUEyRTtRQUMzRSxxREFBcUQ7UUFDckQsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLG9CQUFLLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtZQUNwQyxZQUFZLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSw0QkFBYSxDQUFDLE1BQU0sRUFBRTtZQUN4RCxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSw0QkFBYSxDQUFDLE1BQU0sRUFBRTtZQUNuRCxXQUFXLEVBQUUsMEJBQVcsQ0FBQyxlQUFlO1lBQ3hDLG1CQUFtQixFQUFFLElBQUk7WUFDekIsVUFBVSxFQUFFLDhCQUFlLENBQUMsV0FBVztZQUN2QyxhQUFhLEVBQUUsMkJBQWEsQ0FBQyxPQUFPO1NBQ3JDLENBQUMsQ0FBQztRQUVILDJFQUEyRTtRQUMzRSwyRUFBMkU7UUFDM0UsMEVBQTBFO1FBQzFFLElBQUksQ0FBQyxLQUFLLENBQUMsdUJBQXVCLENBQUM7WUFDakMsU0FBUyxFQUFFLGVBQWU7WUFDMUIsWUFBWSxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsNEJBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDNUQsT0FBTyxFQUFFLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxJQUFJLEVBQUUsNEJBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDdkQsY0FBYyxFQUFFLDZCQUFjLENBQUMsR0FBRztTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDO1FBQ3RDLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUM7UUFDcEMsSUFBSSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxVQUFVLGVBQWUsRUFBRSxDQUFDO1FBRWpFLDJFQUEyRTtRQUMzRSxrRUFBa0U7UUFDbEUsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDL0IsS0FBSyxFQUFFLElBQUksQ0FBQyxTQUFTO1lBQ3JCLFdBQVcsRUFBRSxvQ0FBb0M7WUFDakQsVUFBVSxFQUFFLEdBQUcsSUFBSSxDQUFDLFNBQVMsWUFBWTtTQUMxQyxDQUFDLENBQUM7UUFFSCxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtZQUM5QixLQUFLLEVBQUUsSUFBSSxDQUFDLFFBQVE7WUFDcEIsV0FBVyxFQUFFLG1DQUFtQztZQUNoRCxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsU0FBUyxXQUFXO1NBQ3pDLENBQUMsQ0FBQztRQUVILElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQzdCLEtBQUssRUFBRSxJQUFJLENBQUMsT0FBTztZQUNuQixXQUFXLEVBQUUseURBQXlEO1lBQ3RFLFVBQVUsRUFBRSxHQUFHLElBQUksQ0FBQyxTQUFTLFVBQVU7U0FDeEMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBbEVELDhCQWtFQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IENmbk91dHB1dCwgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFN0YWNrUHJvcHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQge1xuICBBdHRyaWJ1dGVUeXBlLFxuICBCaWxsaW5nTW9kZSxcbiAgUHJvamVjdGlvblR5cGUsXG4gIFRhYmxlLFxuICBUYWJsZUVuY3J5cHRpb24sXG59IGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuLyoqIE5hbWUgb2YgdGhlIHJlY2VuY3ktb3JkZXJlZCBnbG9iYWwgc2Vjb25kYXJ5IGluZGV4IChSZXEgMy43KS4gKi9cbmNvbnN0IEdTSTFfSU5ERVhfTkFNRSA9ICdHU0kxJztcblxuLyoqXG4gKiBEYXRhU3RhY2sg4oCUIHRoZSBzdGF0ZWZ1bCBsYXllci5cbiAqXG4gKiBPd25zIHRoZSBEeW5hbW9EQiBzaW5nbGUgdGFibGUgKG9uLWRlbWFuZCwgUElUUiwgR1NJMSkgdGhhdCBob2xkcyBydW4sIHRhc2ssXG4gKiBhbmQgd29ya2Zsb3ctZ3JhcGggaXRlbXMuIElzb2xhdGVkIGZyb20gdGhlIGZyZXF1ZW50bHktY2hhbmdpbmcgQVBJLCBpbmdlc3QsXG4gKiBhbmQgZnJvbnRlbmQgc3RhY2tzIHNvIGl0cyByZW1vdmFsIHBvbGljeSBhbmQgYmxhc3QgcmFkaXVzIHN0YXkgaW5kZXBlbmRlbnQuXG4gKlxuICogU2luZ2xlLXRhYmxlIGRlc2lnbiAoZGVzaWduLm1kIFwiRHluYW1vREIgc2luZ2xlLXRhYmxlIGRlc2lnblwiKTpcbiAqICAgUHJpbWFyeSBrZXk6IFBLIChwYXJ0aXRpb24pLCBTSyAoc29ydCkuXG4gKiAgIEdTSTE6ICAgICAgICBHU0kxUEsgKHBhcnRpdGlvbiksIEdTSTFTSyAoc29ydCkg4oCUIGFsbCBydW5zIG9yZGVyZWQgYnkgcmVjZW5jeS5cbiAqXG4gKiBSZXF1aXJlbWVudHM6IDMuNiAob24tZGVtYW5kICsgUElUUiksIDMuNyAoR1NJMSBvbiBHU0kxUEsvR1NJMVNLKSxcbiAqIDEyLjMgKG9uLWRlbWFuZCBjYXBhY2l0eSwgbm8gcHJvdmlzaW9uZWQgdGhyb3VnaHB1dCksIDExLjcgKHN0YWNrIG91dHB1dHMpLlxuICovXG5leHBvcnQgY2xhc3MgRGF0YVN0YWNrIGV4dGVuZHMgU3RhY2sge1xuICAvKiogVGhlIHNpbmdsZSBEeW5hbW9EQiB0YWJsZSBob2xkaW5nIHJ1biwgdGFzaywgYW5kIGdyYXBoIGl0ZW1zLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdGFibGU6IFRhYmxlO1xuXG4gIC8qKiBOYW1lIG9mIHRoZSBzaW5nbGUgdGFibGUsIGV4cG9ydGVkIGZvciBkb3duc3RyZWFtIHN0YWNrcyBhbmQgdGhlIGZyb250ZW5kIGJ1aWxkLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdGFibGVOYW1lOiBzdHJpbmc7XG5cbiAgLyoqIEFSTiBvZiB0aGUgc2luZ2xlIHRhYmxlLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdGFibGVBcm46IHN0cmluZztcblxuICAvKiogQVJOIG9mIHRoZSBHU0kxIHJlY2VuY3kgaW5kZXggKHRhYmxlIEFSTiArIGAvaW5kZXgvR1NJMWApLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZ3NpMUFybjogc3RyaW5nO1xuXG4gIC8qKiBOYW1lIG9mIHRoZSByZWNlbmN5LW9yZGVyZWQgZ2xvYmFsIHNlY29uZGFyeSBpbmRleC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGdzaTFOYW1lOiBzdHJpbmcgPSBHU0kxX0lOREVYX05BTUU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBTaW5nbGUgdGFibGUsIG9uLWRlbWFuZCAoUEFZX1BFUl9SRVFVRVNUKSBjYXBhY2l0eSB3aXRoIHBvaW50LWluLXRpbWVcbiAgICAvLyByZWNvdmVyeSBlbmFibGVkIChSZXEgMy42LCAxMi4zKS4gUmVtb3ZhbFBvbGljeS5ERVNUUk9ZIHNvIGBjZGsgZGVzdHJveWBcbiAgICAvLyB0ZWFycyB0aGUgdGFibGUgZG93biBjbGVhbmx5IHdpdGggbm8gb3JwaGFuZWQgcmVzb3VyY2VzIChSZXEgMTEuOSk7IHRoaXNcbiAgICAvLyBpcyBhIGRlbW8vZGFzaGJvYXJkIHN0b3JlLCBub3QgYSBzeXN0ZW0gb2YgcmVjb3JkLlxuICAgIHRoaXMudGFibGUgPSBuZXcgVGFibGUodGhpcywgJ1RhYmxlJywge1xuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdQSycsIHR5cGU6IEF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6ICdTSycsIHR5cGU6IEF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBiaWxsaW5nTW9kZTogQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeTogdHJ1ZSxcbiAgICAgIGVuY3J5cHRpb246IFRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIHJlbW92YWxQb2xpY3k6IFJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vIEdTSTEgc3VwcG9ydHMgbGlzdGluZyBhbGwgcnVucyBvcmRlcmVkIGJ5IGB1cGRhdGVkQXRgIHJlY2VuY3kgKFJlcSAzLjcpLlxuICAgIC8vIEFMTCBwcm9qZWN0aW9uIHNvIHRoZSBmbGVldCBsaXN0IGNhbiByZW5kZXIgZWFjaCBydW4gd2l0aG91dCBhIGZvbGxvdy11cFxuICAgIC8vIEdldEl0ZW0uIE9uLWRlbWFuZCBjYXBhY2l0eSBpcyBpbmhlcml0ZWQgZnJvbSB0aGUgdGFibGUncyBiaWxsaW5nIG1vZGUuXG4gICAgdGhpcy50YWJsZS5hZGRHbG9iYWxTZWNvbmRhcnlJbmRleCh7XG4gICAgICBpbmRleE5hbWU6IEdTSTFfSU5ERVhfTkFNRSxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiAnR1NJMVBLJywgdHlwZTogQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ0dTSTFTSycsIHR5cGU6IEF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBwcm9qZWN0aW9uVHlwZTogUHJvamVjdGlvblR5cGUuQUxMLFxuICAgIH0pO1xuXG4gICAgdGhpcy50YWJsZU5hbWUgPSB0aGlzLnRhYmxlLnRhYmxlTmFtZTtcbiAgICB0aGlzLnRhYmxlQXJuID0gdGhpcy50YWJsZS50YWJsZUFybjtcbiAgICB0aGlzLmdzaTFBcm4gPSBgJHt0aGlzLnRhYmxlLnRhYmxlQXJufS9pbmRleC8ke0dTSTFfSU5ERVhfTkFNRX1gO1xuXG4gICAgLy8gU3RhY2sgb3V0cHV0czogcmVzb3VyY2UgbmFtZXMgYW5kIEFSTnMgYXJlIGV4cG9zZWQgZm9yIGRvd25zdHJlYW0gc3RhY2tzXG4gICAgLy8gYW5kIGluamVjdGlvbiBpbnRvIHRoZSBmcm9udGVuZCBidWlsZCBjb25maWd1cmF0aW9uIChSZXEgMTEuNykuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnVGFibGVOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdOYW1lIG9mIHRoZSBEeW5hbW9EQiBzaW5nbGUgdGFibGUuJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYWJsZU5hbWVgLFxuICAgIH0pO1xuXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnVGFibGVBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy50YWJsZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVJOIG9mIHRoZSBEeW5hbW9EQiBzaW5nbGUgdGFibGUuJyxcbiAgICAgIGV4cG9ydE5hbWU6IGAke3RoaXMuc3RhY2tOYW1lfS1UYWJsZUFybmAsXG4gICAgfSk7XG5cbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdHc2kxQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuZ3NpMUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVJOIG9mIHRoZSBHU0kxIHJlY2VuY3ktb3JkZXJlZCBnbG9iYWwgc2Vjb25kYXJ5IGluZGV4LicsXG4gICAgICBleHBvcnROYW1lOiBgJHt0aGlzLnN0YWNrTmFtZX0tR3NpMUFybmAsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==