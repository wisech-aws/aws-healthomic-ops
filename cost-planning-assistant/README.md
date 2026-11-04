# Cost Planning Assistant (standalone)

A self-contained command-line tool (plus a separate, standalone LLM skill;
see [The LLM skill](#the-llm-skill)) that produces a
**pre-run, what-if cost estimate** for an AWS HealthOmics workflow — before
you've run anything, when no measured task data exists yet. It guides you
through picking instance types, step counts, estimated runtime, and storage
options, then multiplies those assumptions by the **live AWS Price List**.

> **ESTIMATE ONLY — NOT A BILL.** Every figure is a *list-price* estimate:
> your stated assumptions (runtime, scatter width, instance choice, storage
> mode/size) × the published AWS HealthOmics On-Demand Price List for the
> chosen region. It does **not** reflect discounts, credits, Savings Plans,
> Reserved pricing, taxes, or free-tier allowances, and will differ from your
> actual AWS bill. A rate or spec that cannot be found is shown as `—`
> (never a zero), and a total that omits one is marked `PARTIAL`.

## How this differs from `dist-cost-estimator`

| | This tool (`cost-planning-assistant`) | `dist-cost-estimator` |
|---|---|---|
| When | **Before** a workflow runs | **After** a workflow has executed |
| Inputs | Your assumptions (runtime, scatter, storage) | Measured task data from a real run |
| Use it when | You're planning/budgeting a workflow you haven't run yet | You have a Run ID and want the actual measured-cost estimate |

If you already have a Run ID, use `dist-cost-estimator/estimate-run-cost.mjs`
(or the dashboard's Run Detail "Estimated cost" panel) instead — this tool
will tell you the same thing if you say so in the interactive flow.

## Requirements

- **Node.js 20 or newer** (`node --version`).
- **AWS credentials** with read-only pricing access only:
  `pricing:GetProducts` and `pricing:DescribeServices`. No HealthOmics
  permission is required — this tool never calls `omics:*`, and it performs
  no AWS write action.

## Install

From this directory:

```bash
npm install
```

## Usage

### Interactive (guided, one decision at a time)

```bash
node plan-cost.mjs --region us-east-1
```

You'll be walked through: an instance-option menu with live vCPU/memory/GPU/
rate, per-step instance selection (with an optional smallest-fit
recommendation you can accept or override), per-step runtime and scatter
width, a storage mode + size choice, a running summary, and finally the
itemized estimate.

### Non-interactive (scriptable)

Write a plan to a file:

```json
{
  "region": "us-east-1",
  "steps": [
    { "label": "align", "instanceType": "omics.m.large", "runtime": "45m", "scatter": 4 }
  ],
  "storage": { "mode": "STATIC", "sizeGiB": 100, "runtime": "6h" }
}
```

```bash
node plan-cost.mjs --region us-east-1 --input plan.json --json
```

or pipe it via stdin:

```bash
echo '{"steps":[{"label":"align","instanceType":"omics.m.large","runtime":"45m","scatter":4}],"storage":{"mode":"STATIC","sizeGiB":100,"runtime":"6h"}}' \
  | node plan-cost.mjs --region us-east-1 --json
```

Both modes apply the same input validation and the same no-fabrication rules:
a missing rate or an unknown instance spec always shows as unavailable, never
a guessed or zero value.

## Options

| Option | Meaning |
|---|---|
| `--region <r>` | AWS region (or `$AWS_REGION` / `$COST_REGION`). |
| `--interactive` | Run the guided interactive flow (the default when `--input` is not given). |
| `--input <file>` | Run the non-interactive driver, reading assumptions from `<file>` (or from stdin if omitted). |
| `--json` | Emit machine-readable JSON instead of rendered tables. |
| `--help`, `-h` | Print usage and exit. Never imports the AWS SDK or makes a network call. |

## The LLM skill

`skill/cost-planning-assistant.skill.md` is a markdown SOP for an AI agent
that produces the same kind of pre-run, what-if estimate conversationally. It
is fully self-contained: it does not use this CLI or any bundled code or
script, so an agent can follow it on its own. The file contains:

- **The conversation flow.** It first asks whether you have a Run ID (if so,
  it points you to the AWS Billing and Cost Management console or the
  HealthOmics run analyzer for measured cost and stops), then the Region, then
  each workflow step one question at a time (label, resource needs, per-task
  runtime, scatter width) with a running summary, then storage mode, size,
  and overall run wall-clock time. It recommends the smallest fitting
  instance type plus close alternatives, and you confirm every choice.
- **The live price fetch.** Rates are fetched fresh every time and never
  stored in the file. The agent tries, in order, the public HealthOmics price
  list JSON file and the Price List API (`pricing:GetProducts`, through the
  AWS CLI or a SigV4-signed `curl`). If it cannot reach AWS, it hands you the
  query to run, or, as a last resort, asks you to read rates off the AWS
  pricing page and confirm each one. It never takes a rate from memory or
  extrapolates one.
- **The exact math.** The one-minute minimum per task (applied before
  multiplying by scatter width), instance-hours × `Instance-hrs` rate,
  storage GB-hours × the `Run Storage` (STATIC) or `Dynamic Run Storage`
  (DYNAMIC) rate, and STATIC sizes rounded up to a valid size (1,200 GiB,
  2,400 GiB, then 2,400 GiB increments).
- **The instance spec table.** vCPU, memory, and GPU specs for the
  `omics.m`, `omics.c`, `omics.r`, and GPU families, used only for
  recommendations (no prices).
- **The output format.** An itemized table with the arithmetic for each line,
  the total, Region, currency, rate source and retrieval time, any notes, and
  the disclaimer verbatim. A line without a rate shows as unavailable, is
  left out of the total, and marks the estimate `PARTIAL`.
- **A revise loop.** You change one input (instance type, runtime, scatter,
  steps, or storage), and the agent recomputes and re-presents without
  starting over, reusing rates already fetched where it can.

## Handoff for executed runs

If you already have a Run ID for a workflow that has run (or is running),
this tool will not estimate it — the interactive flow asks up front and
directs you to `dist-cost-estimator/estimate-run-cost.mjs`, which prices
*measured* task data rather than assumptions.

## Permissions

This tool is read-only against AWS: it only calls `pricing:GetProducts` /
`pricing:DescribeServices`. It makes no AWS write call and no HealthOmics
call of any kind. No account-specific identifiers (account id, bucket, role,
VPC, workflow id) are required or hardcoded — you supply only a region.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (or `--help`). |
| `2` | Usage / argument / input-validation error. |

## Notes

- A missing/unpriced instance type or storage rate degrades to an explicit
  `—` (unavailable) line item; it never fabricates a number. A total that
  omits an unavailable line item is marked `PARTIAL`.
- Compute cost applies the AWS HealthOmics one-minute-minimum-per-task billing
  floor: each task is billed for at least one minute, applied per task before
  multiplying by scatter width.
