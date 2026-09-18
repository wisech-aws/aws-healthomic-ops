#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { ApiStack } from '../lib/api-stack';
import { IngestStack } from '../lib/ingest-stack';
import { FrontendStack } from '../lib/frontend-stack';

const app = new App();

// Project identifier tag applied at the app level so every taggable resource in
// every stack inherits it (Requirement 11.8). Overridable via CDK context.
const projectTag =
  (app.node.tryGetContext('projectTag') as string | undefined) ??
  'healthomics-workflow-dashboard';
Tags.of(app).add('project', projectTag);

// Environment is resolved from the standard CDK/CLI env vars at deploy time.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Stacks are instantiated in dependency order. Passing the upstream stack as a
// prop creates an explicit dependency so CloudFormation deploys them in order:
// Data -> Api -> Ingest, and Frontend after Api. This guarantees, for example,
// that the Cognito user pool exists before API authorization is configured
// (Requirement 11.10) and that a failure in any stack fails the deployment
// (Requirement 11.11).
const dataStack = new DataStack(app, 'HealthOmicsData', { env });

const apiStack = new ApiStack(app, 'HealthOmicsApi', { env, dataStack });
apiStack.addStackDependency(dataStack);

const ingestStack = new IngestStack(app, 'HealthOmicsIngest', {
  env,
  dataStack,
  apiStack,
});
ingestStack.addStackDependency(dataStack);
ingestStack.addStackDependency(apiStack);

const frontendStack = new FrontendStack(app, 'HealthOmicsFrontend', {
  env,
  apiStack,
});
frontendStack.addStackDependency(apiStack);

app.synth();
