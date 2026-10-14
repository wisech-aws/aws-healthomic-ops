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
scripts/deploy.sh --kinesis-mode present   # select the Kinesis ingest path (default: off)
scripts/deploy.sh --help
```

`--kinesis-mode <off|present|active>` selects the `HealthOmicsIngest` ingest
path (passed through to CDK as `-c kinesisIngestMode=<mode>`):

- `off` (default) — direct EventBridge → Lambda only; no Kinesis resources.
- `present` — also provision the Kinesis stream + consumer, but EventBridge
  still targets the Lambda, so the Kinesis path sits idle (≈ $30/mo idle cost
  for the on-demand stream).
- `active` — EventBridge targets the Kinesis stream, making Kinesis the live
  ingest path. Toggle back to `present`/`off` with a single redeploy; neither
  path is deleted on the toggle.

The default (`off`) does not pass any `-c` flag, so a plain `scripts/deploy.sh`
is unchanged from before.

**Prerequisite checks (fail fast, no auto-install).** Before building or
deploying, the script verifies: the **AWS CLI** is on `PATH`; **Node.js** is
present (warns if the major version is not 20); the **CDK CLI** resolves from
`infra/` (else it tells you to `npm install` there); **AWS credentials** resolve
(else it tells you to run `aws configure` / set `AWS_PROFILE`); and
`node_modules` exists in each package it will use (`ingest/`, `frontend/`,
`infra/`), printing the exact `npm install` command for any that are missing. It
never installs anything for you.

**Bootstrap detection.** It checks whether the target account/region is
CDK-bootstrapped (via the `CDKToolkit` stack or the `/cdk-bootstrap/hnb659fds/version`
SSM parameter). If not, it prints `cd infra && npx cdk bootstrap aws://<account>/<region>`
and exits — it does **not** bootstrap for you.

After a successful full deploy, it prints clear next steps: create your first
sign-in user with [`create-cognito-user.sh`](#create-cognito-usersh--create-a-sign-in-user),
open the `HealthOmicsFrontend` `DistributionDomainName` CloudFront URL from the
deploy outputs, and optionally grant run-metrics emission per run role.

Requires AWS credentials for the target account and a one-time `cdk bootstrap`
per account/region. Deploys are billable.

> **Do not** hand-edit the AppSync auth with `aws appsync update-graphql-api`:
> that call replaces the whole auth config and drops the **IAM** additional-auth
> provider the ingest Lambda needs to publish (→ HTTP 401 on
> `publishRunUpdate`/`publishTaskUpdate`). CDK owns the auth config; if the live
> API drifts, restore it by re-including BOTH the Cognito default AND
> `--additional-authentication-providers '[{"authenticationType":"AWS_IAM"}]'`.

## `create-cognito-user.sh` — create a sign-in user

Creates the first (admin-provisioned) sign-in user for the dashboard. The API's
default authorization is the Cognito user pool and **self-signup is disabled**,
so at least one user must be created by an admin before anyone can sign in.

The helper reads `UserPoolId` (and `Region`) from the deployed `HealthOmicsApi`
stack outputs and the CloudFront domain (`DistributionDomainName`) from the
`HealthOmicsFrontend` stack outputs — nothing is hardcoded. It creates the user
with the invite email suppressed and sets a **permanent** password, so the user
can sign in immediately (no forced password change).

```bash
# Create a user; you'll be prompted securely for a password:
scripts/create-cognito-user.sh --username you@example.com

# Non-email username needs an explicit --email:
scripts/create-cognito-user.sh --username alice --email alice@example.com

# Pass the password non-interactively (e.g. from your secret store):
scripts/create-cognito-user.sh --username you@example.com --password '<StrongPassw0rd!>'

scripts/create-cognito-user.sh --help
```

### Options

| Flag | Description |
|------|-------------|
| `--username <u>` | **Required.** The Cognito username (email alias is enabled, so an email works well). |
| `--email <e>` | Email attribute. Defaults to `--username` when it looks like an email (contains `@`); otherwise required. |
| `--password <p>` | Optional. If omitted, the enforced policy is printed and the password is read securely (`read -s`, never echoed). The script never generates a password. |
| `--region <r>` | AWS region (or `$AWS_REGION`, else `us-east-1`). |
| `--help`, `-h` | Show help. Never contacts AWS. |

**Password policy (enforced by the user pool, validated locally first).** The
password is checked against the policy **before** any AWS call and rejected with
the list of unmet rules if it does not satisfy all of:

- at least **12 characters**,
- at least one **lowercase**, one **uppercase**, one **digit**, and one
  **symbol** (non-alphanumeric),
- not one of the last **3** passwords for that user (password history enforced
  by Cognito), and an admin temporary password would expire in **1 day** — this
  helper sets a `--permanent` password, so that does not apply.

**Outputs on success.** It prints the sign-in URL
(`https://<DistributionDomainName>`) and the username, and a reminder that
self-signup is disabled. It **never** echoes the password.

**Already-exists.** If the user already exists, the helper notes it and resets
(updates) that user's permanent password instead of failing.

**Prerequisites.** The AWS CLI must be on `PATH` and the `HealthOmicsApi` stack
must already be deployed in the target region (it tells you to deploy first if
not). `--help` never touches AWS.

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
| `--role-name <name>` | HealthOmics run role to grant the policy to. **Required** (or set `$RUN_ROLE_NAME`); there is no default — the run role is deployment-specific. |
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

## `estimate-run-cost.mjs` — standalone per-run workflow cost estimator (APIs only)

A UI-free, DynamoDB-free command-line estimator for the **per-run HealthOmics
workflow cost**. Given one or more run IDs it reproduces the dashboard's cost
flow using **only AWS APIs** — it never reads the dashboard's DynamoDB table and
never uses the GraphQL/UI path. Every figure is a **list-price ESTIMATE**
(measured runtime × the published AWS Price List) and the readout carries a
prominent disclaimer that estimates do **not** reflect discounts, credits,
Savings Plans, Reserved pricing, taxes, or free-tier allowances.

APIs used (per run, AWS only):

1. `omics:GetRun` — `startTime`, `stopTime`, `storageType`, `storageCapacity`.
2. `omics:ListRunTasks` (paginated) — per task `instanceType`, `startTime`, `stopTime`.
3. `pricing:GetProducts` — published On-Demand rate map (`AmazonOmics`, `workflowType=Private`); fetched **once** and reused across all runs.
4. CloudWatch PromQL `POST /api/v1/query_range` (SigV4, service `monitoring`) — **DYNAMIC storage only** — run-level filesystem-usage series integrated into GB-hours.

Honesty about availability: any input that cannot be measured or priced is shown
as an explicit `UNAVAILABLE` line item with a reason (never zero-filled); a
`total` that omits unpriced items is marked **PARTIAL**.

### Usage

The estimator is a Node ESM script. You can run the `.mjs` directly if Node 20+
is already installed, or use a **launcher wrapper** that first verifies the
environment (Node present, Node ≥ 20, and the ingest dependencies installed) and
prints actionable install guidance if anything is missing — including the case
where **Node itself is not installed** (which the `.mjs` cannot detect, since it
runs inside Node). Pick the launcher for your OS:

- **macOS / Linux:** `scripts/estimate-run-cost.sh`
- **Windows (cmd.exe / PowerShell):** `scripts\estimate-run-cost.cmd`
- **Direct (any OS, Node already present):** `node scripts/estimate-run-cost.mjs`

```bash
# macOS/Linux launcher (checks Node + deps, then runs):
scripts/estimate-run-cost.sh --run 1234567 --region us-east-1

# ...and auto-install the ingest deps if they're missing:
scripts/estimate-run-cost.sh --install --run 1234567 --region us-east-1
```

```bat
REM Windows launcher (cmd.exe or PowerShell):
scripts\estimate-run-cost.cmd --run 1234567 --region us-east-1
scripts\estimate-run-cost.cmd --install --run 1234567 --region us-east-1
```

```bash
# Direct invocation (requires Node 20+ already on PATH):
node scripts/estimate-run-cost.mjs --help
node scripts/estimate-run-cost.mjs --run 1234567 --region us-east-1
node scripts/estimate-run-cost.mjs 1234567 7654321 --region us-east-1 --json
```

Both launchers accept the wrapper-only `--install` flag (auto-runs
`npm install` in `ingest/` if deps are missing) and forward **all other
arguments unchanged** to the `.mjs`. If Node is not installed they print how to
install it (`.sh`: Homebrew / nvm / nodejs.org; `.cmd`: winget / Chocolatey /
nodejs.org) and exit `127`.

### Options

- `--run <id>` — a run ID to estimate; repeatable. Bare positional run IDs are also accepted.
- `--batch-id <id>` — estimate every run in a HealthOmics batch (resolved via `omics:ListRunsInBatch`); repeatable and combinable with `--run`.
- `--region <r>` — AWS region (or `$AWS_REGION` / `$COST_REGION`). Required.
- `--json` — emit machine-readable JSON (the disclaimer is still included as a field) instead of the text readout.
- `--step-seconds <n>` — DYNAMIC-storage usage query resolution, clamped to ≥ 30 (default 30).
- `--help`, `-h` — print usage and exit; never imports the SDK.

### Aggregate profile (groups of runs)

When more than one run is estimated (via multiple `--run`, a `--batch-id`, or
both), the readout also prints a **cost profile** across the group: for the
whole-run total and for each cost component (every instance type and the storage
family), it reports **sum, mean, median, p90, min, and max**. Following the
Reports view's availability-honesty rule, each statistic is computed **only over
the runs where that value was available** and is labeled with an explicit
"N of M runs" denominator — an unavailable component is never counted as zero.
Runs whose whole estimate failed are excluded from the stats and listed
separately. The same `profile` object is included in `--json` output.

Requires `omics:GetRun`, `omics:ListRunTasks`, `pricing:GetProducts`, (for
`--batch-id`) `omics:ListRunsInBatch`, and (for DYNAMIC-storage runs) CloudWatch
`monitoring` query access. Resolves the AWS SDK from `ingest/node_modules`, so
install the ingest package first (`cd ingest && npm install`); the script runs
from any working directory.

### Dependency preflight

Before doing any AWS work the script runs a **defensive preflight**: it checks
that the runtime is Node 20+ (and has a global `fetch`) and that every required
module (`@aws-sdk/client-omics`, `@aws-sdk/client-pricing`, `@smithy/signature-v4`,
`@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node`) resolves from
`ingest/node_modules`. If anything is missing it prints **all** problems at once
with the exact remediation (`cd ingest && npm install`) and exits **3** without
making any API call. Exit codes: `0` success, `2` usage/argument error, `3`
dependency/environment problem, `1` an unexpected runtime failure. `--help` never
imports the SDK and never triggers the preflight.
