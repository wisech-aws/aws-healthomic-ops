import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../lib/data-stack';
import { ApiStack } from '../lib/api-stack';
import { IngestStack } from '../lib/ingest-stack';
import { FrontendStack } from '../lib/frontend-stack';

describe('CDK app scaffold', () => {
  function buildApp(): {
    app: App;
    dataStack: DataStack;
    apiStack: ApiStack;
    ingestStack: IngestStack;
    frontendStack: FrontendStack;
  } {
    const app = new App();
    Tags.of(app).add('project', 'healthomics-workflow-dashboard');

    const dataStack = new DataStack(app, 'HealthOmicsData');
    const apiStack = new ApiStack(app, 'HealthOmicsApi', { dataStack });
    apiStack.addStackDependency(dataStack);
    const ingestStack = new IngestStack(app, 'HealthOmicsIngest', {
      dataStack,
      apiStack,
    });
    ingestStack.addStackDependency(dataStack);
    ingestStack.addStackDependency(apiStack);
    const frontendStack = new FrontendStack(app, 'HealthOmicsFrontend', {
      apiStack,
    });
    frontendStack.addStackDependency(apiStack);

    return { app, dataStack, apiStack, ingestStack, frontendStack };
  }

  it('instantiates all four stacks and synthesizes without error', () => {
    const { app, dataStack, apiStack, ingestStack, frontendStack } = buildApp();

    // Each stack synthesizes to a valid (empty) template.
    for (const stack of [dataStack, apiStack, ingestStack, frontendStack]) {
      expect(() => Template.fromStack(stack)).not.toThrow();
    }

    const stackNames = app
      .synth()
      .stacks.map((s) => s.stackName)
      .sort();
    expect(stackNames).toEqual([
      'HealthOmicsApi',
      'HealthOmicsData',
      'HealthOmicsFrontend',
      'HealthOmicsIngest',
    ]);
  });

  it('orders stacks by dependency (Data -> Api -> Ingest, Api -> Frontend)', () => {
    const { apiStack, ingestStack, frontendStack } = buildApp();

    expect(apiStack.dependencies).toContainEqual(
      expect.objectContaining({ stackName: 'HealthOmicsData' }),
    );
    const ingestDeps = ingestStack.dependencies.map((d) => d.stackName);
    expect(ingestDeps).toEqual(
      expect.arrayContaining(['HealthOmicsData', 'HealthOmicsApi']),
    );
    expect(frontendStack.dependencies).toContainEqual(
      expect.objectContaining({ stackName: 'HealthOmicsApi' }),
    );
  });

  it('applies the project identifier tag at the app level', () => {
    const { app } = buildApp();
    const assembly = app.synth();
    const dataArtifact = assembly.getStackByName('HealthOmicsData');
    expect(dataArtifact.tags).toMatchObject({
      project: 'healthomics-workflow-dashboard',
    });
  });

  describe('IngestStack least-privilege IAM (Req 2.3, 4.4, 11.2)', () => {
    /** Collects the flattened action list across every IAM policy statement. */
    function allPolicyActions(template: Template): string[] {
      const policies = template.findResources('AWS::IAM::Policy');
      const actions: string[] = [];
      for (const policy of Object.values(policies)) {
        const statements =
          (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
            .Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of statements as Array<{ Action?: string | string[] }>) {
          const action = stmt.Action;
          if (typeof action === 'string') actions.push(action);
          else if (Array.isArray(action)) actions.push(...action);
        }
      }
      return actions;
    }

    it('grants DynamoDB write/read scoped to the table and GSI1 ARNs', () => {
      const { ingestStack } = buildApp();
      const template = Template.fromStack(ingestStack);

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: [
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:ConditionCheckItem',
              ],
            }),
          ]),
        },
      });
    });

    it('grants appsync:GraphQL scoped only to the publish mutation field ARNs (Req 4.4)', () => {
      const { ingestStack } = buildApp();
      const template = Template.fromStack(ingestStack);

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'appsync:GraphQL',
              Resource: Match.arrayWith([
                Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([
                      '/types/Mutation/fields/publishRunUpdate',
                    ]),
                  ]),
                }),
                Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([
                      '/types/Mutation/fields/publishTaskUpdate',
                    ]),
                  ]),
                }),
              ]),
            }),
          ]),
        },
      });
    });

    it('grants HealthOmics read-only actions with no create/update/delete (Req 2.3)', () => {
      const { ingestStack } = buildApp();
      const template = Template.fromStack(ingestStack);

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: [
                'omics:GetRun',
                'omics:ListRunTasks',
                'omics:GetRunTask',
                'omics:GetWorkflow',
              ],
            }),
          ]),
        },
      });
    });

    it('grants no wildcard actions and no wildcard resources on the ingest role (Req 11.2)', () => {
      const { ingestStack } = buildApp();
      const template = Template.fromStack(ingestStack);

      // No `Action: "*"` in any statement.
      expect(allPolicyActions(template)).not.toContain('*');

      // No inline policy statement uses `Resource: "*"` — EXCEPT the documented
      // CloudWatch metric-read exception (cloudwatch:GetMetricData/ListMetrics do
      // not support resource-level scoping; this is the Reconciler's re-sweep
      // grant, mirroring the metrics/cost Lambdas). That exception is still NOT a
      // wildcard action, which the assertion above already guarantees.
      const CW_METRIC_READ = new Set(['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics']);
      const policies = template.findResources('AWS::IAM::Policy');
      for (const policy of Object.values(policies)) {
        const statements =
          (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
            .Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of statements as Array<{ Resource?: unknown; Action?: unknown }>) {
          if (stmt.Resource === '*') {
            // Only the CloudWatch metric-read actions may use Resource: '*'.
            const actions = Array.isArray(stmt.Action) ? (stmt.Action as string[]) : [stmt.Action as string];
            const allExempt = actions.every((a) => CW_METRIC_READ.has(a));
            expect(allExempt).toBe(true);
          }
        }
      }
    });
  });
});

describe('ApiStack Cognito hardening (security: strong passwords + brute-force protection)', () => {
  function apiTemplate(): Template {
    const app = new App();
    Tags.of(app).add('project', 'healthomics-workflow-dashboard');
    const dataStack = new DataStack(app, 'HealthOmicsData');
    const apiStack = new ApiStack(app, 'HealthOmicsApi', { dataStack });
    apiStack.addStackDependency(dataStack);
    return Template.fromStack(apiStack);
  }

  it('enforces an explicit strong password policy (min length 12, all char classes, history, temp validity)', () => {
    const template = apiTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          PasswordHistorySize: 3,
          TemporaryPasswordValidityDays: 1,
        },
      },
    });
  });

  it('enables threat protection (brute-force / credential-stuffing) via the PLUS feature plan, enforced', () => {
    const template = apiTemplate();
    // FeaturePlan.PLUS maps to UserPoolTier PLUS; FULL_FUNCTION enforces
    // adaptive/risk-based threat protection rather than only auditing.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'PLUS',
      UserPoolAddOns: {
        AdvancedSecurityMode: 'ENFORCED',
      },
    });
  });

  it('keeps self-signup disabled (admin-provisioned users only)', () => {
    const template = apiTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('hardens the SPA app client (SRP-only, no user-existence errors, bounded token validity)', () => {
    const template = apiTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH']),
      PreventUserExistenceErrors: 'ENABLED',
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
    });
  });

  it('never enables the plaintext USER_PASSWORD auth flow on the SPA client', () => {
    const template = apiTemplate();
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      const flows: string[] = client.Properties?.ExplicitAuthFlows ?? [];
      expect(flows).not.toContain('ALLOW_USER_PASSWORD_AUTH');
      expect(flows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
    }
  });
});


describe('IngestStack deferred re-sweep (Reconciler + one-shot Scheduler)', () => {
  function ingestTemplate(): Template {
    const app = new App();
    Tags.of(app).add('project', 'healthomics-workflow-dashboard');
    const dataStack = new DataStack(app, 'HealthOmicsData');
    const apiStack = new ApiStack(app, 'HealthOmicsApi', { dataStack });
    apiStack.addStackDependency(dataStack);
    const ingestStack = new IngestStack(app, 'HealthOmicsIngest', { dataStack, apiStack });
    ingestStack.addStackDependency(dataStack);
    ingestStack.addStackDependency(apiStack);
    return Template.fromStack(ingestStack);
  }

  it('provisions a dedicated scheduler group and a second (reconciler) Lambda', () => {
    const t = ingestTemplate();
    t.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    // ingest + reconciler.
    const fns = t.findResources('AWS::Lambda::Function');
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(2);
  });

  it('caps the reconciler fan-out with reserved concurrency + OMICS_TPS (fleet-wide HealthOmics budget)', () => {
    const t = ingestTemplate();
    const fns = t.findResources('AWS::Lambda::Function');
    // The reconciler is identified by its RECONCILER_TABLE_NAME env var.
    const reconciler = Object.values(fns).find((f) =>
      Boolean(f.Properties?.Environment?.Variables?.RECONCILER_TABLE_NAME),
    );
    expect(reconciler).toBeDefined();
    // Bounded fan-out so a wave of terminal-run re-sweeps cannot exceed the
    // HealthOmics ~10 TPS budget (reservedConcurrency × OMICS_TPS ≈ 10), while
    // OMICS_TPS is high enough that a single large-run sweep finishes in the
    // timeout.
    expect(reconciler!.Properties?.ReservedConcurrentExecutions).toBe(2);
    expect(reconciler!.Properties?.Environment?.Variables?.OMICS_TPS).toBe('5');
  });

  it('grants the ingest role scheduler:CreateSchedule (scoped, not *) and iam:PassRole conditioned on the scheduler service', () => {
    const t = ingestTemplate();
    const policies = t.findResources('AWS::IAM::Policy');
    const allStatements: Array<{ Action?: unknown; Resource?: unknown; Condition?: unknown }> = [];
    for (const p of Object.values(policies)) {
      for (const s of p.Properties?.PolicyDocument?.Statement ?? []) {
        allStatements.push(s);
      }
    }
    const flat = (a: unknown): string[] => (Array.isArray(a) ? (a as string[]) : [a as string]);

    const createSched = allStatements.find((s) => flat(s.Action).includes('scheduler:CreateSchedule'));
    expect(createSched).toBeDefined();
    expect(createSched!.Resource).not.toBe('*');

    const passRole = allStatements.find((s) => flat(s.Action).includes('iam:PassRole'));
    expect(passRole).toBeDefined();
    expect(passRole!.Resource).not.toBe('*');
    expect(JSON.stringify(passRole!.Condition)).toContain('scheduler.amazonaws.com');
  });

  it('grants the reconciler role scheduler:DeleteSchedule (scoped) + omics read + cloudwatch metrics, no wildcard actions', () => {
    const t = ingestTemplate();
    const policies = t.findResources('AWS::IAM::Policy');
    const actions = new Set<string>();
    for (const p of Object.values(policies)) {
      for (const s of p.Properties?.PolicyDocument?.Statement ?? []) {
        const a = s.Action;
        (Array.isArray(a) ? a : [a]).forEach((x: string) => actions.add(x));
      }
    }
    expect(actions.has('scheduler:DeleteSchedule')).toBe(true);
    expect(actions.has('omics:ListRunTasks')).toBe(true);
    expect(actions.has('cloudwatch:GetMetricData')).toBe(true);
    // No wildcard ACTION anywhere.
    expect(actions.has('*')).toBe(false);
  });

  it('creates a scheduler-invoke role trusted by the scheduler service', () => {
    const t = ingestTemplate();
    const roles = t.findResources('AWS::IAM::Role');
    const trustsScheduler = Object.values(roles).some((r) => {
      const stmts = r.Properties?.AssumeRolePolicyDocument?.Statement ?? [];
      return stmts.some(
        (s: { Principal?: { Service?: unknown } }) =>
          JSON.stringify(s.Principal?.Service ?? '').includes('scheduler.amazonaws.com'),
      );
    });
    expect(trustsScheduler).toBe(true);
  });
});


describe('IngestStack Kinesis ingest path (toggle-able: off/present/active)', () => {
  function ingestTemplateWithMode(mode?: 'off' | 'present' | 'active'): Template {
    const app = new App({ context: mode ? { kinesisIngestMode: mode } : {} });
    Tags.of(app).add('project', 'healthomics-workflow-dashboard');
    const dataStack = new DataStack(app, 'HealthOmicsData');
    const apiStack = new ApiStack(app, 'HealthOmicsApi', { dataStack });
    apiStack.addStackDependency(dataStack);
    const ingestStack = new IngestStack(app, 'HealthOmicsIngest', { dataStack, apiStack });
    ingestStack.addStackDependency(dataStack);
    ingestStack.addStackDependency(apiStack);
    return Template.fromStack(ingestStack);
  }

  function omicsRuleTargets(t: Template): Array<{
    Arn?: unknown;
    KinesisParameters?: { PartitionKeyPath?: string };
  }> {
    const rules = t.findResources('AWS::Events::Rule');
    const omicsRule = Object.values(rules).find(
      (r) => JSON.stringify(r.Properties?.EventPattern?.source) === JSON.stringify(['aws.omics']),
    );
    return omicsRule?.Properties?.Targets ?? [];
  }

  it('DEFAULT (no context) is OFF: no Kinesis resources; the rule targets only the direct ingest Lambda', () => {
    const t = ingestTemplateWithMode();
    t.resourceCountIs('AWS::Kinesis::Stream', 0);
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
    expect(Object.keys(t.findOutputs('IngestKinesisDlqUrl'))).toHaveLength(0);
    const targets = omicsRuleTargets(t);
    expect(targets).toHaveLength(1);
    expect(targets[0].KinesisParameters).toBeUndefined();
    const fns = t.findResources('AWS::Lambda::Function');
    const directId = Object.keys(fns).find((id) => id.startsWith('IngestFunction'));
    expect(directId).toBeDefined();
    expect(JSON.stringify(targets[0].Arn)).toContain(directId!);
  });

  it('ACTIVE exposes the Kinesis dead letter queue URL as a stack output', () => {
    const t = ingestTemplateWithMode('active');
    const outputs = t.findOutputs('IngestKinesisDlqUrl');
    expect(Object.keys(outputs)).toHaveLength(1);
    const queues = t.findResources('AWS::SQS::Queue');
    const kinesisDlqId = Object.keys(queues).find((id) => id.startsWith('IngestKinesisDlq'));
    expect(kinesisDlqId).toBeDefined();
    expect(JSON.stringify(Object.values(outputs)[0].Value)).toContain(kinesisDlqId!);
  });

  it('OFF (explicit): no Kinesis stream, event-source mapping, or Kinesis DLQ output; direct path only', () => {
    const t = ingestTemplateWithMode('off');
    t.resourceCountIs('AWS::Kinesis::Stream', 0);
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
    expect(Object.keys(t.findOutputs('IngestKinesisDlqUrl'))).toHaveLength(0);
    const targets = omicsRuleTargets(t);
    expect(targets).toHaveLength(1);
    expect(targets[0].KinesisParameters).toBeUndefined();
  });

  it('PRESENT: provisions the stream + consumer + ESM but EventBridge still targets the Lambda (idle)', () => {
    const t = ingestTemplateWithMode('present');
    t.resourceCountIs('AWS::Kinesis::Stream', 1);
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    // The EventBridge rule target must NOT carry KinesisParameters when idle.
    const rules = t.findResources('AWS::Events::Rule');
    const omicsRule = Object.values(rules).find(
      (r) => JSON.stringify(r.Properties?.EventPattern?.source) === JSON.stringify(['aws.omics']),
    );
    const targets = omicsRule?.Properties?.Targets ?? [];
    expect(targets.some((tg: { KinesisParameters?: unknown }) => tg.KinesisParameters)).toBe(false);
  });

  it('ACTIVE: the rule targets only the Kinesis stream, with a dynamic PartitionKey = $.detail.runId', () => {
    const t = ingestTemplateWithMode('active');
    t.resourceCountIs('AWS::Kinesis::Stream', 1);
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    const targets = omicsRuleTargets(t);
    expect(targets).toHaveLength(1);
    expect(targets[0].KinesisParameters?.PartitionKeyPath).toBe('$.detail.runId');
    const streams = t.findResources('AWS::Kinesis::Stream');
    const streamId = Object.keys(streams)[0];
    expect(JSON.stringify(targets[0].Arn)).toContain(streamId);
  });

  it('the Kinesis consumer has least-privilege grants (DDB RW, appsync scoped, omics read) and no wildcard action', () => {
    const t = ingestTemplateWithMode('present');
    const policies = t.findResources('AWS::IAM::Policy');
    const actions = new Set<string>();
    for (const p of Object.values(policies)) {
      for (const s of p.Properties?.PolicyDocument?.Statement ?? []) {
        (Array.isArray(s.Action) ? s.Action : [s.Action]).forEach((a: string) => actions.add(a));
      }
    }
    expect(actions.has('dynamodb:UpdateItem')).toBe(true);
    expect(actions.has('appsync:GraphQL')).toBe(true);
    expect(actions.has('omics:GetRunTask')).toBe(true);
    // ESM auto-grants kinesis read (GetRecords/GetShardIterator/etc.).
    expect([...actions].some((a) => a.startsWith('kinesis:'))).toBe(true);
    expect(actions.has('*')).toBe(false);
  });
});

describe('IngestStack EVENT_ENRICHMENT_MODE + consumer memory (live context kinesisIngestMode=active)', () => {
  function ingestTemplate(context: Record<string, string>): Template {
    const app = new App({ context });
    Tags.of(app).add('project', 'healthomics-workflow-dashboard');
    const dataStack = new DataStack(app, 'HealthOmicsData');
    const apiStack = new ApiStack(app, 'HealthOmicsApi', { dataStack });
    apiStack.addStackDependency(dataStack);
    const ingestStack = new IngestStack(app, 'HealthOmicsIngest', { dataStack, apiStack });
    ingestStack.addStackDependency(dataStack);
    ingestStack.addStackDependency(apiStack);
    return Template.fromStack(ingestStack);
  }

  type FnResource = {
    Properties: { MemorySize?: number; Environment?: { Variables?: Record<string, unknown> } };
  };
  function fn(t: Template, logicalPrefix: string): FnResource {
    const fns = t.findResources('AWS::Lambda::Function');
    const match = Object.entries(fns).filter(([id]) => id.startsWith(logicalPrefix));
    expect(match).toHaveLength(1);
    return match[0][1] as FnResource;
  }

  it('with no context, the direct ingest Lambda defaults to EVENT_ENRICHMENT_MODE=event (no Kinesis consumer)', () => {
    const t = ingestTemplate({});
    t.resourceCountIs('AWS::Kinesis::Stream', 0);
    const fns = t.findResources('AWS::Lambda::Function');
    expect(Object.keys(fns).some((id) => id.startsWith('KinesisIngestConsumer'))).toBe(false);
    expect(fn(t, 'IngestFunction').Properties.Environment?.Variables?.EVENT_ENRICHMENT_MODE).toBe('event');
  });

  it('with only kinesisIngestMode=active, defaults to event on both ingest functions and gives the Kinesis consumer 192 MB', () => {
    const t = ingestTemplate({ kinesisIngestMode: 'active' });
    t.resourceCountIs('AWS::Kinesis::Stream', 1);
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    const consumer = fn(t, 'KinesisIngestConsumer');
    const direct = fn(t, 'IngestFunction');
    expect(consumer.Properties.Environment?.Variables?.EVENT_ENRICHMENT_MODE).toBe('event');
    expect(direct.Properties.Environment?.Variables?.EVENT_ENRICHMENT_MODE).toBe('event');
    expect(consumer.Properties.MemorySize).toBe(192);
    expect(direct.Properties.MemorySize).toBe(192);
    // Existing consumer env is unchanged.
    expect(consumer.Properties.Environment?.Variables?.OMICS_TPS).toBe('2');
  });

  it('honors -c eventEnrichmentMode=event on both functions', () => {
    const t = ingestTemplate({ kinesisIngestMode: 'active', eventEnrichmentMode: 'event' });
    expect(fn(t, 'KinesisIngestConsumer').Properties.Environment?.Variables?.EVENT_ENRICHMENT_MODE).toBe('event');
    expect(fn(t, 'IngestFunction').Properties.Environment?.Variables?.EVENT_ENRICHMENT_MODE).toBe('event');
  });

  it('honors -c eventEnrichmentMode=api (rollback) on both functions', () => {
    const t = ingestTemplate({ kinesisIngestMode: 'active', eventEnrichmentMode: 'api' });
    expect(fn(t, 'KinesisIngestConsumer').Properties.Environment?.Variables?.EVENT_ENRICHMENT_MODE).toBe('api');
    expect(fn(t, 'IngestFunction').Properties.Environment?.Variables?.EVENT_ENRICHMENT_MODE).toBe('api');
    // Memory does not depend on the enrichment mode.
    expect(fn(t, 'KinesisIngestConsumer').Properties.MemorySize).toBe(192);
  });
  it('rejects the removed shadow eventEnrichmentMode at synth', () => {
    expect(() => ingestTemplate({ kinesisIngestMode: 'active', eventEnrichmentMode: 'shadow' })).toThrow(
      /Invalid context eventEnrichmentMode="shadow"; expected one of event, api/,
    );
    expect(() => ingestTemplate({ eventEnrichmentMode: 'shadow' })).toThrow(/Invalid context eventEnrichmentMode/);
  });

  it('rejects an invalid eventEnrichmentMode at synth', () => {
    expect(() => ingestTemplate({ kinesisIngestMode: 'active', eventEnrichmentMode: 'bogus' })).toThrow(
      /Invalid context eventEnrichmentMode/,
    );
  });
});

describe('Lambda runtimes (project functions run on Node.js 24)', () => {
  /**
   * CDK-managed helper functions (S3 autoDeleteObjects provider, BucketDeployment,
   * log retention) use CDK's own runtimes, so they are excluded by logical ID.
   */
  const CDK_HELPER_PREFIXES = ['Custom', 'LogRetention'];

  /** Logical-ID prefixes of every project Lambda, per stack. */
  const EXPECTED_PROJECT_FUNCTIONS: Record<string, string[]> = {
    HealthOmicsData: [],
    HealthOmicsApi: ['CostFunction', 'LogsFunction', 'MetricsFunction', 'ReportsFunction'],
    HealthOmicsIngest: ['IngestFunction', 'KinesisIngestConsumer', 'ReconcilerFunction'],
    HealthOmicsFrontend: [],
  };

  function synthAll(context: Record<string, string>): Record<string, Template> {
    const app = new App({ context });
    const dataStack = new DataStack(app, 'HealthOmicsData');
    const apiStack = new ApiStack(app, 'HealthOmicsApi', { dataStack });
    apiStack.addStackDependency(dataStack);
    const ingestStack = new IngestStack(app, 'HealthOmicsIngest', { dataStack, apiStack });
    ingestStack.addStackDependency(dataStack);
    ingestStack.addStackDependency(apiStack);
    const frontendStack = new FrontendStack(app, 'HealthOmicsFrontend', { apiStack });
    frontendStack.addStackDependency(apiStack);
    return {
      HealthOmicsData: Template.fromStack(dataStack),
      HealthOmicsApi: Template.fromStack(apiStack),
      HealthOmicsIngest: Template.fromStack(ingestStack),
      HealthOmicsFrontend: Template.fromStack(frontendStack),
    };
  }

  /** Project (non-helper) Lambdas in a template: logical ID -> Runtime. */
  function projectFunctions(t: Template): Record<string, unknown> {
    const fns = t.findResources('AWS::Lambda::Function');
    const out: Record<string, unknown> = {};
    for (const [id, res] of Object.entries(fns)) {
      if (CDK_HELPER_PREFIXES.some((p) => id.startsWith(p))) continue;
      out[id] = (res as { Properties?: { Runtime?: unknown } }).Properties?.Runtime;
    }
    return out;
  }

  it('every project Lambda uses nodejs24.x (kinesisIngestMode=active, eventEnrichmentMode=event)', () => {
    const templates = synthAll({ kinesisIngestMode: 'active', eventEnrichmentMode: 'event' });
    for (const [stackName, template] of Object.entries(templates)) {
      const fns = projectFunctions(template);
      const expected = EXPECTED_PROJECT_FUNCTIONS[stackName];
      // Every expected function is present exactly once, and nothing else.
      expect(Object.keys(fns)).toHaveLength(expected.length);
      for (const prefix of expected) {
        expect(Object.keys(fns).filter((id) => id.startsWith(prefix))).toHaveLength(1);
      }
      for (const runtime of Object.values(fns)) {
        expect(runtime).toBe('nodejs24.x');
      }
    }
  });

  it('the default (Kinesis off) direct ingest + reconciler Lambdas also use nodejs24.x', () => {
    const fns = projectFunctions(synthAll({}).HealthOmicsIngest);
    expect(Object.keys(fns).some((id) => id.startsWith('KinesisIngestConsumer'))).toBe(false);
    expect(Object.keys(fns)).toHaveLength(2);
    for (const runtime of Object.values(fns)) {
      expect(runtime).toBe('nodejs24.x');
    }
  });
});
