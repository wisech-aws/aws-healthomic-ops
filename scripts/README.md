# Scripts

Operational and local-verification scripts.

## `send-event.mjs` — synthetic-event / direct-invoke (Req 13.4, 13.6)

An executable operator script that, selectable by the operator, EITHER publishes
a synthetic `aws.omics` event to EventBridge (`PutEvents`) OR invokes the ingest
Lambda directly with a fixture (`Invoke`). Before sending, it validates the
fixture against the same schema the ingest pipeline assumes (`source` ===
`aws.omics`, `detail-type` is one of `Run Status Change` / `Task Status Change`,
required `detail` fields present, status in the enum). An event that fails
validation is **rejected with a clear error and nothing is sent**, so existing
run and task data is left unchanged (Req 13.6).

The `--help` and `--dry-run` paths never import the AWS SDK and never contact
AWS, so validation and arg-parsing can be verified without credentials.

### Usage

```bash
# Validate the bundled run fixture without touching AWS:
scripts/send-event.mjs --dry-run --fixture run

# Publish a synthetic task event to the default EventBridge bus:
scripts/send-event.mjs --mode eventbridge --fixture task --region us-west-2

# Invoke the ingest Lambda directly with a run fixture:
scripts/send-event.mjs --mode lambda --fixture run \
    --function healthomics-ingest --region us-west-2
```

### Options

| Flag | Description |
|------|-------------|
| `--mode <m>` | `eventbridge` or `lambda` (required unless `--dry-run`). |
| `--fixture <path>` | Fixture JSON path, or the shorthand `run` / `task` (default: `run`). |
| `--function <name>` | Lambda function name/ARN for `lambda` mode (or `$INGEST_FUNCTION_NAME`). |
| `--event-bus <name>` | EventBridge bus for `eventbridge` mode (default `default`, or `$EVENT_BUS_NAME`). |
| `--region <region>` | AWS region (or `$AWS_REGION`). |
| `--dry-run` | Validate + print what would be sent; never contacts AWS. |
| `--help`, `-h` | Show help. |

Sending modes lazily import the AWS SDK v3 clients (`@aws-sdk/client-eventbridge`,
`@aws-sdk/client-lambda`). Run the script with a Node.js resolution context that
provides those (e.g. from the `ingest/` package or a workspace that installs
them). The fixtures it sends live under `../fixtures/events/`.

## `ensure-run-metrics-permission.mjs` — grant run-role metric emission (Req 4.3)

An idempotent operator script that grants a HealthOmics **run role**
`cloudwatch:PutMetricData` so that HealthOmics can **emit** run/task
utilization metrics to CloudWatch for runs using that role. This is the
emission-side precondition for the `run-utilization-metrics` feature's
`getRunMetrics` query: the dashboard *reads* metrics via a separate
reader-side permission already wired into the CDK `ApiStack`
(`cloudwatch:GetMetricData` / `cloudwatch:ListMetrics` on the reader role),
but HealthOmics will never produce those metrics for a run unless the run's
own IAM role already holds `cloudwatch:PutMetricData` at the time the run
starts. The run role is a HealthOmics service role, not created by this
repo's CDK, so it cannot be added to a stack — this script manages it
out-of-band instead.

It is **safe to re-run**: it reads the role's current inline policy (if any)
via `GetRolePolicy` and only calls `PutRolePolicy` when the policy is missing
or differs from the desired document, so re-running it never duplicates
statements or fails because the policy already exists.

The `--help` path never imports the AWS SDK and never touches AWS. `--dry-run`
performs the same read-only checks as a normal run but is guaranteed to skip
the mutating `PutRolePolicy` call — it only reports what would happen.

### Usage

```bash
# See usage without touching AWS or needing credentials:
scripts/ensure-run-metrics-permission.mjs --help

# Check the default TEST-environment role without changing anything:
scripts/ensure-run-metrics-permission.mjs --dry-run

# Ensure the policy on a specific role in a specific region:
scripts/ensure-run-metrics-permission.mjs \
    --role-name MyOmicsRunRole --region us-west-2
```

### Options

| Flag | Description |
|------|-------------|
| `--role-name <name>` | HealthOmics run role to grant the policy to. Defaults to `$RUN_ROLE_NAME`, or `OmicsWorkflow-20260224075057` (this project's TEST-environment role only — pass `--role-name` for any other account/role). |
| `--region <region>` | AWS region for client construction (or `$AWS_REGION`). IAM is a global service; this only affects which regional endpoint/partition the client resolves. |
| `--policy-name <name>` | Inline policy name to create/update. Defaults to `HealthOmicsRunMetrics-PutMetricData`. |
| `--dry-run` | Check current state and print what would be done; never calls `PutRolePolicy` (no mutation). |
| `--help`, `-h` | Show help. Never imports the AWS SDK. |

**When to run it.** Run it **once per run role**, not once per deploy —
against the HealthOmics run role, **before** starting any runs that should
emit metrics. It is an out-of-band IAM operation on a service role this
repo's CDK does not own, so it is never part of `cdk deploy --all`.

**Cost note.** Granting `cloudwatch:PutMetricData` enables CloudWatch metric
ingestion for runs using that role from then on, and CloudWatch bills for
metric ingestion/storage. **Not retroactive:** runs started *before* the
policy is applied have no metrics, ever — there is no way to backfill them
after the fact.

`@aws-sdk/client-iam` is imported lazily (only when not just printing help)
and is not currently a declared dependency of any `package.json` in this
repo; make sure it is resolvable from this script's location before running
it in a non-`--help` mode (e.g. `npm install @aws-sdk/client-iam` in a
directory on the Node resolution path, or `npx --package=@aws-sdk/client-iam`).

## `inject-config.mjs` — frontend build-time config injection (Req 11.7)

Consumes the ApiStack CDK outputs and writes the four `VITE_*` environment
variables the frontend build reads (see `frontend/src/api/config.ts`), so the
SPA carries no hardcoded environment values.

### Wiring

```bash
# 1. Emit the API stack outputs to a JSON file.
cd infra
cdk deploy HealthOmicsApi --outputs-file ../cdk-outputs.json

# 2. Inject them into the frontend build env (from the frontend package):
cd ../frontend
npm run inject-config   # reads ../cdk-outputs.json, writes .env.production

# 3. Build the SPA (Vite reads VITE_* from .env.production):
npm run build
```

Or invoke the script directly:

```bash
node scripts/inject-config.mjs \
  --outputs cdk-outputs.json \
  --stack HealthOmicsApi \
  --out frontend/.env.production
```

### Output mapping

| CDK output id (ApiStack) | Vite env var |
|--------------------------|--------------|
| `GraphqlApiUrl`      | `VITE_APPSYNC_ENDPOINT`     |
| `UserPoolId`         | `VITE_USER_POOL_ID`         |
| `UserPoolClientId`   | `VITE_USER_POOL_CLIENT_ID`  |
| `Region`             | `VITE_AWS_REGION`           |

The generated `.env.*` files are gitignored. The script fails with a clear
error if the outputs file, the named stack, or any required output is missing.
