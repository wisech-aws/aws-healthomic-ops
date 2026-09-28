# Scripts

Operational and local-verification scripts.

## `deploy.sh` — build and deploy in one command

Runs the correct deploy sequence so you never publish a stale or missing
`frontend/dist`: **build ingest → build the SPA → `cdk deploy`** (CDK resolves
cross-stack order Data → Api → Ingest, Api → Frontend). Prefer this over calling
`cdk deploy --all` directly, which does **not** build the SPA.

```bash
scripts/deploy.sh                          # build ingest + SPA, deploy all stacks
scripts/deploy.sh --frontend-only          # build SPA, deploy only HealthOmicsFrontend
scripts/deploy.sh --stack HealthOmicsApi   # build, deploy one named stack
scripts/deploy.sh --skip-build             # deploy without rebuilding (use with care)
scripts/deploy.sh --region us-west-2       # override region (default: $AWS_REGION or us-east-1)
scripts/deploy.sh --help
```

Requires AWS credentials for the target account and a one-time `cdk bootstrap`
per account/region. Deploys are billable.

> **Do not** hand-edit the AppSync auth with `aws appsync update-graphql-api`:
> that call replaces the whole auth config and drops the **IAM** additional-auth
> provider the ingest Lambda needs to publish (→ HTTP 401 on
> `publishRunUpdate`/`publishTaskUpdate`). CDK owns the auth config; if the live
> API drifts, restore it by re-including BOTH the Cognito default AND
> `--additional-authentication-providers '[{"authenticationType":"AWS_IAM"}]'`.

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

---

## `backfill-run-summaries.mjs` — one-time Run_Summary backfill (workflow-performance-reports Req 9)

The **Reports** feature aggregates over per-run performance rollups
(`Run_Summary` items) that the ingest pipeline writes when a run reaches a
terminal state. Runs that finished **before** the feature shipped have no
rollup, so this one-time, **idempotent** script creates them from data already
stored in the single table:

- **Run-level facts** (duration, status, task shape, workflow name/version/id)
  come from the stored `RUN` + `TASK` items — always available.
- **Utilization** (CPU/memory means & peaks) comes from a bounded CloudWatch
  PromQL sweep, **only** for runs still within the ~15-month retention window;
  older runs (or any sweep failure) are backfilled with utilization flagged
  **unavailable** rather than fabricated.

It reuses the ingest package's **compiled** helpers, so build ingest first:

```bash
cd ingest && npm run build && cd ..
```

### Usage

```bash
# See usage without touching AWS or needing credentials:
scripts/backfill-run-summaries.mjs --help

# Report what WOULD be written, without writing (read-only scans + sweep):
scripts/backfill-run-summaries.mjs --dry-run --table-name <TableName> --region <region>

# Backfill for real (safe to re-run — idempotent monotonic upsert):
scripts/backfill-run-summaries.mjs --table-name <TableName> --region <region>
```

### Options

| Option | Description |
|--------|-------------|
| `--table-name <name>` | DynamoDB single table (or `$TABLE_NAME`). Required. |
| `--region <region>` | AWS region (or `$AWS_REGION`). Required. |
| `--retention-days <n>` | CloudWatch retention window in days for the utilization sweep (default `450` ≈ 15 months). Runs older than this are backfilled with utilization unavailable. |
| `--rate-ms <n>` | Minimum delay between CloudWatch sweeps, ms (default `250`), to stay within API limits. |
| `--skip-metrics` | Skip the CloudWatch sweep entirely; backfill only run-level facts (utilization unavailable for all). |
| `--limit <n>` | Process at most N runs (for a bounded trial run). |
| `--dry-run` | Scan/compute and report; never write summaries. |
| `--help`, `-h` | Print help and exit. Never imports the SDK. |

`--help` never touches AWS. `--dry-run` performs the same read-only scans (and,
unless `--skip-metrics`, the CloudWatch sweep) but is **guaranteed** to skip the
summary write. The script requires read access to the table and, for the
utilization sweep, the same CloudWatch PromQL permissions the metrics reader
uses (`cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`).


## `repair-bare-tasks.mjs` — re-enrich bare terminal tasks

Repairs **bare** terminal task items — tasks persisted with only a `status`
(no `startedAt`/`stoppedAt`/`name`/`cpus`/`memory`) because their `GetRunTask`
enrichment was throttled/lost during a large batch. It re-fetches each bare task
via `GetRunTask` (rate-limited to the ~10 TPS HealthOmics budget, reusing the
ingest limiter), upserts the repaired record, and rebuilds the affected
`Run_Summary` rollups. The ingest handler's terminal-task-throw guard prevents
new bare tasks going forward; this repairs items written before that fix.

### Usage

```bash
# Build ingest first so the compiled enrichment modules exist:
(cd ingest && npm run build)

# Dry-run over a batch (reports bare tasks, writes nothing):
node scripts/repair-bare-tasks.mjs --batch-id <id> --dry-run \
    --table-name <table> --region us-east-1

# Apply:
node scripts/repair-bare-tasks.mjs --batch-id <id> \
    --table-name <table> --region us-east-1
```

Accepts `--batch-id <id>` or `--run-ids a,b,...`, `--tps <n>` (default 10), and
`--dry-run`. Resolves the AWS SDK from `ingest/node_modules`.

## `repair-task-status.mjs` — correct stuck task status

Repairs task items whose stored `status` disagrees with the authoritative
HealthOmics `ListRunTasks` status (e.g. a task stuck `RUNNING` even though the
run is `COMPLETED`). This happened when an out-of-order / redelivered
non-terminal task event overwrote a terminal status. The ingest repository now
carries a **status-monotonic guard** (a terminal status can never be reverted to
non-terminal, regardless of `updatedAt`) so this can no longer happen going
forward; this script fixes items written before the guard.

For each run it reads the authoritative task statuses from HealthOmics
(paginated, rate-limited), compares to the stored items, and for any mismatch
writes the correct status — plus `stoppedAt` when the authoritative task has a
stop time — with a freshly-bumped `updatedAt` so the corrected value wins.

### Usage

```bash
# Build ingest first (for SDK resolution parity with the other scripts):
(cd ingest && npm run build)

# Dry-run over a batch (reports mismatches, writes nothing):
node scripts/repair-task-status.mjs --batch-id <id> --dry-run \
    --table-name <table> --region us-east-1

# Apply:
node scripts/repair-task-status.mjs --batch-id <id> \
    --table-name <table> --region us-east-1
```

Accepts `--batch-id <id>` or `--run-ids a,b,...`, `--tps <n>` (default 10), and
`--dry-run`. Requires read access to the table + `omics:ListRunTasks` /
`omics:ListRunsInBatch`, and DynamoDB update access. Resolves the AWS SDK from
`ingest/node_modules`.
