# Cost Planning Assistant — LLM Skill

A step-by-step SOP for an AI agent to guide a user through a **pre-run, what-if
cost estimate** for an AWS HealthOmics workflow. This skill drives the
`plan-cost.mjs` CLI (in this `cost-planning-assistant/` package) in its
non-interactive `--json` mode. It never computes a rate or a cost itself —
every number shown to the user must come from the CLI's output.

## The disclaimer (include this verbatim, every time an estimate is shown)

> ESTIMATE ONLY — NOT A BILL. This is a rough planning estimate computed from
> published AWS On-Demand list prices and the assumptions you supplied
> (runtime, scatter width, instance choice, storage mode and size). It
> excludes overhead, rounding, credits, discounts, Savings Plans, and
> Reserved pricing, and will differ from your actual AWS bill.

This is the exact text of `ESTIMATE_DISCLAIMER` in `src/estimationCore.mjs`,
and it is also returned as the `disclaimer` field of every `--json` result
and printed with every rendered estimate. Always show it (or quote the CLI's
own `disclaimer` field) — never paraphrase it away.

## Step 1 — Check for a Run_Id first

Ask the user: **"Do you already have a Run ID for a workflow that has
executed or is executing?"**

- If **yes**: do not proceed with this skill. Tell the user a *measured*
  post-run cost estimate is available, and direct them to the existing
  post-run estimator in this project:
  - `dist-cost-estimator/estimate-run-cost.mjs <runId> --region <region>`, or
  - the Run Detail "Estimated cost" panel in the dashboard.

  Stop here. Do not re-implement or approximate post-run estimation yourself.

- If **no**: continue to Step 2. The user is planning a workflow that has not
  run yet, so every quantity (runtime, scatter width, instance choice, storage
  size) must come from the user as an explicit assumption — never infer it
  from a workflow definition, and never default it silently.

## Step 2 — Gather the user's plan, one decision at a time

Collect, conversationally, one question at a time (do not dump every question
in a single message):

1. **Region.** Ask which AWS region to price against. If the user doesn't
   know, mention that it should match where they intend to run the workflow.
2. **Steps.** For each step of the workflow the user wants to plan:
   - Ask what the step does (a short label).
   - Ask if they know their resource need (min vCPU / min memory / whether a
     GPU is needed). If they give one, you may call `plan-cost.mjs` to fetch
     the instance menu and compute a *recommendation* with
     `recommendSmallestFit` — but **never decide for the user**. Present the
     recommendation and let them confirm it or pick a different instance type
     from the menu.
   - Ask for the step's estimated **per-task** runtime (a duration, e.g.
     `"45m"`, `"1.5h"`) and its **scatter width** (how many parallel tasks run
     this step, e.g. one per sample).
   - Ask if there's another step to add; repeat.
3. **Storage.** Ask the user's preferred storage mode, briefly explaining the
   difference:
   - **STATIC** = a fixed reserved capacity billed for the run duration.
   - **DYNAMIC** = usage-based billing.

   Then ask for the storage size (e.g. `"100GiB"`) and the run's overall
   expected wall-clock runtime (used to compute storage GB-hours).

Keep a running summary of what's been gathered so far and show it back to the
user periodically, so they always know the current state of their plan.

## Step 3 — Drive the CLI, never restate rates or re-derive math

Once you have the full plan, build the JSON input shape:

```json
{
  "region": "us-east-1",
  "steps": [
    { "label": "align", "instanceType": "omics.m.large", "runtime": "45m", "scatter": 4 }
  ],
  "storage": { "mode": "STATIC", "sizeGiB": 100, "runtime": "6h" }
}
```

Invoke the CLI non-interactively:

```bash
echo '<the JSON above>' | node plan-cost.mjs --region us-east-1 --json
```

(or write it to a file and use `--input <file> --json`).

Treat the CLI's `--json` output as the **sole source of numbers**. Do not
compute a rate, an instance hour, a GB-hour, or a cost yourself, and do not
restate what a rate "should" be — only ever report what the CLI returned.

## Step 4 — Present options and the estimate as tables

When showing the available instance options (vCPU, memory, GPU, rate) or the
final estimate (line items, total), format the CLI's output as a clear table
in the chat. You may reformat for readability, but you must not alter any
number or add a number the CLI did not return.

## Step 5 — Surface Unavailable_State honestly

If the CLI's output shows `available: false` for a line item, or `—` in
rendered output, say so plainly (e.g. "no published rate was found for
`omics.x.large` in this region, so that line is not included in the total").
Never fill in a guessed number. If `partial: true`, tell the user the total is
incomplete because at least one line item could not be priced.

## Step 6 — Let the user revise and re-estimate

After presenting an estimate, ask if the user wants to change anything
(a different instance type, a different runtime, a different storage size,
etc.). If so, update just that part of the gathered plan and re-invoke the CLI
with the updated JSON — do not make the user restart the whole conversation.

## Summary of rules this skill must always follow

- Check for a Run_Id first; hand off to the post-run estimator if present.
- Gather every planning assumption from the user explicitly — never infer or
  silently default runtime, scatter width, instance choice, or storage size.
- Recommend, never decide: a suggested instance type always requires the
  user's explicit confirmation or override.
- All pricing and math come from `plan-cost.mjs`'s `--json` output
  (`src/estimationCore.mjs` under the hood) — never restated or re-derived
  here.
- Always show the Estimate_Disclaimer with any estimate.
- Always surface an Unavailable_State (`available:false` / `—`) as-is; never
  fabricate a rate, spec, or assumption.
- Let the user revise and re-estimate without restarting.
