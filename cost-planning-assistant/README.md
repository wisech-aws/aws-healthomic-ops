# Cost Planning Assistant (standalone)

A self-contained command-line tool (plus an LLM skill asset) that produces a
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

### Non-interactive (scriptable; also what the LLM skill drives)

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

`skill/cost-planning-assistant.skill.md` is a markdown SOP for an AI agent: it
drives this CLI's non-interactive `--json` mode conversationally, presents
the instance menu and the estimate as tables, recommends instance choices
without deciding for the user, and defers every rate and every calculation to
this CLI — it never restates a price or re-derives the math.

The skill also supports a **direct-API mode** for agents that cannot run
`node` (some sandboxes can't execute node or read shell profiles). In that
mode the agent calls the AWS Price List API itself (read-only
`pricing:GetProducts`) for live rates and does the cost math by hand, using
the exact query, parsing rules, and formulas transcribed into the skill from
this package's verified source. The primary direct-API fetch is a single
SigV4-signed `curl` to the Price List API (no AWS CLI, MCP, or node required).
Driving the CLI remains the preferred, single
source of truth; direct-API mode mirrors it exactly and never fabricates a
rate.

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
