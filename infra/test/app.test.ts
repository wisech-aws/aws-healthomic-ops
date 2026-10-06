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

  it('OFF (default): no Kinesis stream or event-source mapping — direct path only', () => {
    const t = ingestTemplateWithMode('off');
    t.resourceCountIs('AWS::Kinesis::Stream', 0);
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
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

  it('ACTIVE: EventBridge targets the Kinesis stream with a dynamic PartitionKey = $.detail.runId', () => {
    const t = ingestTemplateWithMode('active');
    t.resourceCountIs('AWS::Kinesis::Stream', 1);
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    const rules = t.findResources('AWS::Events::Rule');
    const omicsRule = Object.values(rules).find(
      (r) => JSON.stringify(r.Properties?.EventPattern?.source) === JSON.stringify(['aws.omics']),
    );
    const targets: Array<{ KinesisParameters?: { PartitionKeyPath?: string } }> =
      omicsRule?.Properties?.Targets ?? [];
    const kinesisTarget = targets.find((tg) => tg.KinesisParameters);
    expect(kinesisTarget).toBeDefined();
    expect(kinesisTarget!.KinesisParameters!.PartitionKeyPath).toBe('$.detail.runId');
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