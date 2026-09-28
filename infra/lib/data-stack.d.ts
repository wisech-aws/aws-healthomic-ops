import { Stack, StackProps } from 'aws-cdk-lib';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
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
export declare class DataStack extends Stack {
    /** The single DynamoDB table holding run, task, and graph items. */
    readonly table: Table;
    /** Name of the single table, exported for downstream stacks and the frontend build. */
    readonly tableName: string;
    /** ARN of the single table. */
    readonly tableArn: string;
    /** ARN of the GSI1 recency index (table ARN + `/index/GSI1`). */
    readonly gsi1Arn: string;
    /** Name of the recency-ordered global secondary index. */
    readonly gsi1Name: string;
    /** ARN of the GSI2 Workflow_Group index (table ARN + `/index/GSI2`). */
    readonly gsi2Arn: string;
    /** Name of the Workflow_Group index used by aggregate reports. */
    readonly gsi2Name: string;
    constructor(scope: Construct, id: string, props?: StackProps);
}
