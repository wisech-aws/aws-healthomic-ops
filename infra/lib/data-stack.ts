import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

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
export class DataStack extends Stack {
  /** The single DynamoDB table holding run, task, and graph items. */
  public readonly table: Table;

  /** Name of the single table, exported for downstream stacks and the frontend build. */
  public readonly tableName: string;

  /** ARN of the single table. */
  public readonly tableArn: string;

  /** ARN of the GSI1 recency index (table ARN + `/index/GSI1`). */
  public readonly gsi1Arn: string;

  /** Name of the recency-ordered global secondary index. */
  public readonly gsi1Name: string = GSI1_INDEX_NAME;

  /** ARN of the GSI2 Workflow_Group index (table ARN + `/index/GSI2`). */
  public readonly gsi2Arn: string;

  /** Name of the Workflow_Group index used by aggregate reports. */
  public readonly gsi2Name: string = GSI2_INDEX_NAME;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Single table, on-demand (PAY_PER_REQUEST) capacity with point-in-time
    // recovery enabled (Req 3.6, 12.3). RemovalPolicy.DESTROY so `cdk destroy`
    // tears the table down cleanly with no orphaned resources (Req 11.9); this
    // is a demo/dashboard store, not a system of record.
    this.table = new Table(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GSI1 supports listing all runs ordered by `updatedAt` recency (Req 3.7).
    // ALL projection so the fleet list can render each run without a follow-up
    // GetItem. On-demand capacity is inherited from the table's billing mode.
    this.table.addGlobalSecondaryIndex({
      indexName: GSI1_INDEX_NAME,
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // GSI2 supports the aggregate Reports feature: all Run_Summary rows for one
    // Workflow_Group (`GSI2PK = WF#<name>#<version>`) ordered by terminal
    // timestamp (`GSI2SK`), so a windowed report is a single range query per
    // group (workflow-performance-reports Req 2.2). ALL projection so the
    // Reports Lambda can aggregate every summary attribute without a follow-up
    // GetItem. On-demand capacity is inherited from the table's billing mode.
    this.table.addGlobalSecondaryIndex({
      indexName: GSI2_INDEX_NAME,
      partitionKey: { name: 'GSI2PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.tableName = this.table.tableName;
    this.tableArn = this.table.tableArn;
    this.gsi1Arn = `${this.table.tableArn}/index/${GSI1_INDEX_NAME}`;
    this.gsi2Arn = `${this.table.tableArn}/index/${GSI2_INDEX_NAME}`;

    // Stack outputs: resource names and ARNs are exposed for downstream stacks
    // and injection into the frontend build configuration (Req 11.7).
    new CfnOutput(this, 'TableName', {
      value: this.tableName,
      description: 'Name of the DynamoDB single table.',
      exportName: `${this.stackName}-TableName`,
    });

    new CfnOutput(this, 'TableArn', {
      value: this.tableArn,
      description: 'ARN of the DynamoDB single table.',
      exportName: `${this.stackName}-TableArn`,
    });

    new CfnOutput(this, 'Gsi1Arn', {
      value: this.gsi1Arn,
      description: 'ARN of the GSI1 recency-ordered global secondary index.',
      exportName: `${this.stackName}-Gsi1Arn`,
    });

    new CfnOutput(this, 'Gsi2Arn', {
      value: this.gsi2Arn,
      description: 'ARN of the GSI2 Workflow_Group index used by aggregate reports.',
      exportName: `${this.stackName}-Gsi2Arn`,
    });
  }
}
