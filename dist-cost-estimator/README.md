# HealthOmics Cost Estimator (standalone)

A self-contained command-line tool that estimates the **per-run AWS HealthOmics
workflow cost** using **only AWS APIs**. It does not read any DynamoDB table and
does not use any GraphQL/UI backend — give it a run ID (or a batch, or a list of
runs) and it prints a cost readout.

> **ESTIMATE ONLY — NOT A BILL.** Every figure is a *list-price* estimate:
> measured run/task runtime × the published AWS HealthOmics On-Demand Price List
> for the chosen region. It does **not** reflect discounts, credits, Savings
> Plans, Reserved pricing, private pricing, taxes, or free-tier allowances, and
> will differ from your actual AWS bill. Inputs that cannot be measured/priced
> are shown as `UNAVAILABLE` (never counted as zero); a total that omits them is
> marked `PARTIAL`.

## Requirements

- **Node.js 20 or newer** (`node --version`). The tool uses the global `fetch`
  API and is tested on Node 20+.
- **AWS credentials** for the account/region where the runs executed, with
  permission to call: `omics:GetRun`, `omics:ListRunTasks`,
  `omics:ListRunsInBatch` (only for `--batch-id`), `pricing:GetProducts`, and —
  for DYNAMIC-storage runs — the CloudWatch `monitoring` query API
  (`aps`/`GetMetricData`-equivalent PromQL `query_range`).
  Configure via `aws configure`, `AWS_PROFILE`, or
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`.

## Install

From this directory:

```bash
npm install
```

This downloads the pinned AWS SDK dependencies into a local `node_modules/`.

## Run

Use the launcher for your OS (it checks Node + deps first and gives guidance if
anything is missing), or call Node directly.

**macOS / Linux:**
```bash
./estimate-run-cost.sh 1234567 --region us-east-1
./estimate-run-cost.sh --install 1234567 --region us-east-1   # auto-run npm install if needed
```

**Windows (cmd.exe or PowerShell):**
```bat
estimate-run-cost.cmd 1234567 --region us-east-1
estimate-run-cost.cmd --install 1234567 --region us-east-1
```

**Direct (any OS, after `npm install`):**
```bash
node estimate-run-cost.mjs --help
node estimate-run-cost.mjs 1234567 --region us-east-1
node estimate-run-cost.mjs 1234567 7654321 --region us-east-1 --json
```

## Options

| Option | Meaning |
|---|---|
| `--run <id>` | A run ID to estimate. Repeatable. Bare positional run IDs also work. |
| `--batch-id <id>` | Estimate every run in a HealthOmics batch (via `omics:ListRunsInBatch`). Repeatable; combinable with `--run`. |
| `--region <r>` | AWS region (or `$AWS_REGION` / `$COST_REGION`). **Required.** |
| `--json` | Emit machine-readable JSON instead of the text readout. |
| `--step-seconds <n>` | DYNAMIC-storage usage query resolution, clamped to ≥ 30 (default 30). |
| `--install` | (launcher only) auto-run `npm install` if dependencies are missing. |
| `--help`, `-h` | Print usage and exit. Never needs AWS or the SDK. |

## What it does (the cost method)

For each run it calls:

1. `omics:GetRun` → the run window (`startTime` → `stopTime` or now), `storageType`, `storageCapacity`.
2. `omics:ListRunTasks` → each task's `instanceType`, `startTime`, `stopTime`.
3. `pricing:GetProducts` → the region's published On-Demand rates (fetched once, reused across all runs).
4. CloudWatch PromQL `query_range` (DYNAMIC storage only) → the run's filesystem-usage series.

Then:
- **Compute** = Σ per instance type of `(stop − start) hours × published rate`.
- **Storage** = STATIC: `capacity(GiB) × run hours × rate`; DYNAMIC: trapezoidal integral of the usage series (GB-hours) × rate.
- **Total** = sum of the *available* line items (PARTIAL if any are unavailable).

When more than one run is estimated, a **cost profile** is printed: sum, mean,
median, p90, min, and max for the run total and for each cost component, with an
explicit "N of M runs" denominator for every statistic (unavailable values are
never counted as zero).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `2` | Usage / argument error. |
| `3` | Dependency or environment problem (e.g. Node too old, deps not installed). |
| `127` | Node.js is not installed (from the launcher). |
| `1` | Unexpected runtime failure. |

## Notes

- The tool is read-only against AWS — it only calls describe/list/get and pricing APIs.
- A missing/failed input degrades to an explicit `UNAVAILABLE` line item or a typed per-run error; it never fabricates a number.
