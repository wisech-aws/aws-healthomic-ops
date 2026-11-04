# Cost Planning Assistant: LLM Skill (self-contained)

A step-by-step SOP for an AI agent to guide a user through a **pre-run, what-if
cost estimate** for an AWS HealthOmics private workflow. This is planning math:
a "what would this roughly cost if I ran it like so" answer. It is **not a bill
and not a measured cost**.

This skill is fully self-contained. It does not depend on any bundled code, CLI,
or script. Everything the agent needs is in this file:

- the conversation flow (Steps 1 to 4),
- how to fetch live prices (Step 5),
- the exact math (Step 6),
- the instance spec table used for recommendations (Step 7),
- the output format (Step 8) and the revise loop (Step 9).

The only external input is **live AWS prices**, which must be fetched fresh every
time. Rates are never stored in this file.

## The disclaimer (include verbatim every time an estimate is shown)

> ESTIMATE ONLY: NOT A BILL. This is a rough planning estimate computed from published AWS On-Demand list prices and the assumptions you supplied (runtime, scatter width, instance choice, storage mode and size). It excludes overhead, rounding, credits, discounts, Savings Plans, and Reserved pricing, and will differ from your actual AWS bill.

Always show it. Never paraphrase it away. Also state where the rates came from
(which Step 5 method) and when they were retrieved.

## Step 1: Check for a Run ID first

Ask: **"Do you already have a Run ID for a workflow that has executed or is
executing?"**

- **Yes:** this skill does not apply. A run that has already executed has
  measured usage, which is more accurate than any assumption. Point the user to
  the AWS Billing and Cost Management console (cost per run) or the HealthOmics
  run analyzer to review actual task resources and cost. Stop here.
- **No:** continue. Every quantity (runtime, scatter width, instance choice,
  storage size) must come from the user as an explicit assumption. Never infer
  it from a workflow definition and never default it silently.

## Step 2: Region

Ask which AWS Region to price. It should match where the workflow will run.
Prices differ by Region.

## Step 3: Gather the workflow steps, one decision at a time

Ask one question per message. Keep a running summary and show it back after
each answer.

For each workflow step:

1. **Label:** what the step does (for example "alignment").
2. **Resource need:** minimum vCPUs, minimum memory, and whether a GPU is
   needed. Use the Instance spec table (Step 7) to **recommend** the smallest
   instance type that satisfies all requirements. HealthOmics maps each task to
   the smallest omics instance that fits the requested vCPUs, memory, and GPUs.
   If a task requests no vCPU or memory, HealthOmics uses `omics.c.large`.
   Present the recommendation plus one or two close alternatives and let the
   user confirm or override. **Never decide for the user.**
3. **Per-task runtime:** a duration with a unit (for example `45m`, `2h`).
4. **Scatter width:** how many tasks run this step (often one per sample).
5. Ask if there is another step. Repeat until done.

## Step 4: Gather storage

Explain the two modes, then ask which one:

- **STATIC:** pre-provisioned capacity billed for the run duration. Priced on
  the `Run Storage` rate. **Minimum size is 1,200 GiB, then 2,400 GiB, then
  additional increments of 2,400 GiB** (1,200 / 2,400 / 4,800 / 7,200 ...). If
  the user gives a size that cannot be provisioned, round **up** to the next
  valid size and tell them.
- **DYNAMIC:** scales with usage, no minimum. Priced on the `Dynamic Run
  Storage` rate. The size is a user assumption; say so when presenting.

Then ask for:

- **Storage size** (for example `500GiB`, `1TiB`).
- **Overall run wall-clock time** from start to finish (used for storage
  GB-hours). Suggest it be at least as long as the longest step and include
  some allowance for startup and staging.

### Unit conversions

- **Durations to hours** (unit suffix required, case-insensitive):
  `s` divide by 3600, `m` divide by 60, `h` as-is, `d` multiply by 24.
  Examples: `90s` = 0.025h, `30m` = 0.5h, `2d` = 48h.
- **Sizes to GiB:** `GiB` as-is, `TiB` multiply by 1024, a bare number is GiB.
  Examples: `0.5TiB` = 512, `1TiB` = 1024.

## Step 5: Fetch live rates

Before fetching, compute and show the quantities (instance-hours per step and
storage GB-hours) from the user's inputs using Step 6. Quantities do not depend
on rates, so the user can review them while rates are being gathered.

Try the methods quickly in order. If the agent's own attempts (A, B) fail, say
which ones failed and why in one short list, then move straight to Method C.
Do not keep retrying blocked paths.

Fetch rates for the target Region now. Use the first method that works. **Never
invent, guess, reuse, or recall a rate from memory.**

### What you need

- For each chosen instance type: the On-Demand USD rate with unit `Instance-hrs`.
- For storage: the On-Demand USD rate with unit `GB-Hours` for `Run Storage`
  (STATIC) or `Dynamic Run Storage` (DYNAMIC).
- All for **private** workflows (`workflowType = Private`).

### Method A: public price list file (no credentials needed)

AWS publishes the HealthOmics price list as a public JSON file. Replace
`us-east-1` in the path with the target Region:

```
https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonOmics/current/us-east-1/index.json
```

The file has `products` (keyed by SKU) and `terms.OnDemand` (keyed by the same
SKU). With `curl` and `jq`:

```bash
curl -s https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonOmics/current/us-east-1/index.json \
| jq -r '. as $d | $d.products | to_entries[]
  | select(.value.productFamily=="Compute")
  | select(.value.attributes.workflowType=="Private")
  | .key as $sku | .value.attributes.resourceType as $rt
  | $d.terms.OnDemand[$sku][].priceDimensions[]
  | "\($rt)\t\(.unit)\t\(.pricePerUnit.USD)"'
```

### Method B: Price List Query API (needs read-only `pricing:GetProducts`)

The Price List API endpoint lives in `us-east-1`. Always call it there, and
select the target Region with the `regionCode` filter. Pricing data is
account-agnostic, so any AWS account's credentials work.

AWS CLI:

```bash
aws pricing get-products --region us-east-1 --service-code AmazonOmics \
  --filters 'Type=TERM_MATCH,Field=regionCode,Value=<target-region>' \
            'Type=TERM_MATCH,Field=workflowType,Value=Private' \
  --output json
```

Or a SigV4-signed `curl` (curl 7.75 or later). Use env-var placeholders, never
literal keys. Add `-H "X-Amz-Security-Token: $AWS_SESSION_TOKEN"` only when
using temporary (STS/SSO) credentials:

```bash
curl -sS -X POST "https://api.pricing.us-east-1.amazonaws.com/" \
  --aws-sigv4 "aws:amz:us-east-1:pricing" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -H "X-Amz-Target: AWSPriceListService.GetProducts" \
  -H "Content-Type: application/x-amz-json-1.1" \
  -d '{"ServiceCode":"AmazonOmics","Filters":[{"Type":"TERM_MATCH","Field":"regionCode","Value":"<target-region>"},{"Type":"TERM_MATCH","Field":"workflowType","Value":"Private"}],"FormatVersion":"aws_v1","MaxResults":100}'
```

**Pagination:** if the response has `NextToken`, repeat the call with it
(`--starting-token` for the CLI, `"NextToken"` in the curl body) until it is
absent. Accumulate every page. Each `PriceList` entry is a JSON string; parse it
before reading fields.

### Method C: the user runs the query

If the agent cannot reach AWS (no network, no credentials, or it cannot run
`curl` or the AWS CLI), hand the query to the user. This is the dependable
fallback and was the path that worked in testing.

1. Give the user a targeted command for each needed resource type. For the
   AWS CLI, add a `resourceType` filter so each call returns one product:

   ```bash
   aws pricing get-products --region us-east-1 --service-code AmazonOmics \
     --filters 'Type=TERM_MATCH,Field=regionCode,Value=<target-region>' \
               'Type=TERM_MATCH,Field=workflowType,Value=Private' \
               'Type=TERM_MATCH,Field=resourceType,Value=<resource-type>' \
     --output json
   ```

   Use one call per instance type, plus one for `Run Storage` or
   `Dynamic Run Storage`. Remind the user to run `aws sso login` or add
   `--profile <name>` if needed, and to include every page if a `NextToken`
   is returned. Method A's `curl | jq` command is the no-credentials option.
2. Accept either the raw JSON or a short `resourceType  unit  rate` summary.
   Apply the parsing rules below and check each unit (`Instance-hrs` for
   compute, `GB-Hours` for storage).
3. **Ask which method the user ran** (Method A, Method B, or the pricing page)
   unless they already said so. Do not assume the method from the shape of
   the output. Record the source as that method, "run by the user", with the
   time the rates were provided.

### Method D: AWS public pricing page (user-confirmed only)

The page `https://aws.amazon.com/healthomics/pricing/` loads rates dynamically,
and an agent's text fetch is often truncated or missing the rate tables. Worked
pricing examples on that page are illustrations, not a rate table. Because of
this, the agent must **never** take a rate from this page on its own.

Use this method only like this:

1. Ask the user to open the page in their browser, select the target Region,
   and read off the exact rate for each needed line (instance type
   `Instance-hrs` rate, and `Run Storage` or `Dynamic Run Storage` `GB-Hours`
   rate).
2. The user types or pastes each rate. The agent repeats each one back with its
   resource type, unit, and Region, and asks the user to confirm.
3. Record the method as "public pricing page, user-confirmed" with the time.

Hard rules for Method D:

- The agent never supplies, reads, quotes, or pre-fills a rate from the page
  itself, even if a fetch appears to show one.
- Never extrapolate a rate from another instance size or family (for example,
  do not multiply an `xlarge` rate by 4 to get `4xlarge`).
- Never use a number from a worked example as a rate.
- Any line the user cannot confirm is **unavailable**.

**If no method produces a rate, say so plainly and stop.**

### Parsing rules (apply to every method)

Keep a product only if **all** hold:

1. `productFamily` is `Compute` (both compute and run storage use this family).
2. `attributes.resourceType` is a non-empty string.
3. It has an On-Demand price dimension with a string `unit` and a
   `pricePerUnit.USD` that parses to a finite number. Use only On-Demand USD.
4. The unit matches the family:
   - **Compute:** `resourceType` starts with `omics.` and unit is `Instance-hrs`.
   - **Storage:** `resourceType` is exactly `Run Storage` or `Dynamic Run
     Storage` and unit is `GB-Hours`.

Skip everything else: Ephemeral Storage, sequence/reference/variant/annotation
store products, Ready2Run per-run products, and any unit mismatch. Take **only
the rate** from the price data. Take vCPU, memory and GPU specs from the table
in Step 7, never from the price data.

Build a rate map: `resourceType -> { rate, unit }`. Record the retrieval
timestamp and the method used. A resource type with no surviving entry has **no
rate**: treat it as unavailable, never as 0.

## Step 6: The exact math

```
ONE_MINUTE_HOURS = 1/60
```

**Per compute step:**

```
billedTaskHours = max(perTaskRuntimeHours, ONE_MINUTE_HOURS)   # per task, BEFORE scatter
minimumApplied  = billedTaskHours > perTaskRuntimeHours        # mention it if true
instanceHours   = billedTaskHours * scatterWidth
cost            = instanceHours * instanceRate                 # Instance-hrs rate
```

The 60-second minimum is applied **per task, before** multiplying by scatter
width. Tasks are otherwise billed per second, so fractional hours are fine.

**Storage:**

```
rateFamily = STATIC ? "Run Storage" : "Dynamic Run Storage"
sizeGiB    = STATIC ? roundUpToValidStaticSize(sizeGiB) : sizeGiB
gbHours    = sizeGiB * runWallClockHours
cost       = gbHours * storageRate                             # GB-Hours rate

roundUpToValidStaticSize(x): 1200 if x <= 1200, 2400 if x <= 2400,
                            else 2400 * ceil(x / 2400)
```

**Total (no fabrication):**

```
total   = sum of cost for line items that HAVE a rate
partial = true if ANY line item has no rate
```

A line with no rate shows `unavailable` for rate and cost, is excluded from the
total, and the estimate is marked **PARTIAL**.

### Worked example (floor applied per task)

Per-task runtime `30s` (0.008333h), scatter 4, instance rate R:

```
billedTaskHours = max(0.008333, 0.016667) = 0.016667   # minimumApplied = true
instanceHours   = 0.016667 * 4 = 0.066667
cost            = 0.066667 * R
```

Flooring after multiplying by scatter (max(0.0333, 0.0167) = 0.0333) is wrong.

## Step 7: Instance spec table (hardware specs, not rates)

These specs are stable and safe to embed (source: AWS doc "Compute and memory
requirements for HealthOmics tasks"). Use them only to recommend the smallest
fitting type. Prices are never stored here.

Memory-per-vCPU ratios for the non-GPU families: Standard `omics.m.*` = 4 GiB
per vCPU, Compute `omics.c.*` = 2 GiB per vCPU, Memory `omics.r.*` = 8 GiB per
vCPU.

### Standard family (`omics.m.*`)

| Instance type | vCPUs | Memory (GiB) |
|---|---|---|
| omics.m.large | 2 | 8 |
| omics.m.xlarge | 4 | 16 |
| omics.m.2xlarge | 8 | 32 |
| omics.m.4xlarge | 16 | 64 |
| omics.m.8xlarge | 32 | 128 |
| omics.m.12xlarge | 48 | 192 |
| omics.m.16xlarge | 64 | 256 |
| omics.m.24xlarge | 96 | 384 |
| omics.m.32xlarge | 128 | 512 |
| omics.m.48xlarge | 192 | 768 |

### Compute family (`omics.c.*`)

| Instance type | vCPUs | Memory (GiB) |
|---|---|---|
| omics.c.large | 2 | 4 |
| omics.c.xlarge | 4 | 8 |
| omics.c.2xlarge | 8 | 16 |
| omics.c.4xlarge | 16 | 32 |
| omics.c.8xlarge | 32 | 64 |
| omics.c.12xlarge | 48 | 96 |
| omics.c.16xlarge | 64 | 128 |
| omics.c.24xlarge | 96 | 192 |
| omics.c.32xlarge | 128 | 256 |
| omics.c.48xlarge | 192 | 384 |

### Memory family (`omics.r.*`)

| Instance type | vCPUs | Memory (GiB) |
|---|---|---|
| omics.r.large | 2 | 16 |
| omics.r.xlarge | 4 | 32 |
| omics.r.2xlarge | 8 | 64 |
| omics.r.4xlarge | 16 | 128 |
| omics.r.8xlarge | 32 | 256 |
| omics.r.12xlarge | 48 | 384 |
| omics.r.16xlarge | 64 | 512 |
| omics.r.24xlarge | 96 | 768 |
| omics.r.32xlarge | 128 | 1024 |
| omics.r.48xlarge | 192 | 1536 |

### GPU families (irregular; transcribed verbatim)

GPU count/memory do not follow the vCPU ratio. GPU families only go up to
24xlarge (no 32xlarge/48xlarge GPU instance is documented).

`omics.g6.*`: Nvidia L4:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g6.xlarge | 4 | 16 | 1 | 24 |
| omics.g6.2xlarge | 8 | 32 | 1 | 24 |
| omics.g6.4xlarge | 16 | 64 | 1 | 24 |
| omics.g6.8xlarge | 32 | 128 | 1 | 24 |
| omics.g6.12xlarge | 48 | 192 | 4 | 96 |
| omics.g6.16xlarge | 64 | 256 | 1 | 24 |
| omics.g6.24xlarge | 96 | 384 | 4 | 96 |

`omics.g6e.*`: Nvidia L40s:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g6e.xlarge | 4 | 32 | 1 | 48 |
| omics.g6e.2xlarge | 8 | 64 | 1 | 48 |
| omics.g6e.4xlarge | 16 | 128 | 1 | 48 |
| omics.g6e.8xlarge | 32 | 256 | 1 | 48 |
| omics.g6e.12xlarge | 48 | 384 | 4 | 192 |
| omics.g6e.16xlarge | 64 | 512 | 1 | 48 |
| omics.g6e.24xlarge | 96 | 768 | 4 | 192 |

`omics.g5.*`: Nvidia Tesla A10G:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g5.xlarge | 4 | 16 | 1 | 24 |
| omics.g5.2xlarge | 8 | 32 | 1 | 24 |
| omics.g5.4xlarge | 16 | 64 | 1 | 24 |
| omics.g5.8xlarge | 32 | 128 | 1 | 24 |
| omics.g5.12xlarge | 48 | 192 | 4 | 96 |
| omics.g5.16xlarge | 64 | 256 | 1 | 24 |
| omics.g5.24xlarge | 96 | 384 | 4 | 96 |

`omics.g4dn.*`: Nvidia Tesla T4:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g4dn.xlarge | 4 | 16 | 1 | 16 |
| omics.g4dn.2xlarge | 8 | 32 | 1 | 16 |
| omics.g4dn.4xlarge | 16 | 64 | 1 | 16 |
| omics.g4dn.8xlarge | 32 | 128 | 1 | 16 |
| omics.g4dn.12xlarge | 48 | 192 | 4 | 64 |
| omics.g4dn.16xlarge | 64 | 256 | 1 | 16 |

## Step 8: Present the estimate

Show an aligned markdown table:

| Usage | Quantity | Unit | Rate | Cost |
|---|---|---|---|---|
| align (omics.m.4xlarge x 10) | 20 | Instance-hrs | <live> USD | <computed> USD |
| Dynamic Run Storage (500 GiB x 3h) | 1,500 | GB-Hours | <live> USD | <computed> USD |

Then show:

- **TOTAL:** sum of available line items only.
- **Region**, **Currency** (USD), **Rates retrieved** (timestamp and method).
- **PARTIAL** badge if any line is unavailable, naming the line(s) and why.
- Notes: any per-task minimum applied, any STATIC size rounded up, and that
  DYNAMIC size is an assumption.
- The disclaimer, verbatim.

Show the arithmetic for each line (quantity x rate = cost) so the user can
check it.

## Step 9: Revise and re-estimate (the loop)

Ask if the user wants to change anything: instance type, per-task runtime,
scatter width, add or remove a step, storage mode, size, or run time. Change
only that input, reuse the already-fetched rates if the Region and instance
types are unchanged (fetch any new instance type's rate), recompute, and
re-present. Never make the user start over. Repeat until they are satisfied.

## Rules this skill always follows

- **Self-contained.** No bundled code or CLI is required. The agent follows
  this file.
- **Live rates only.** Fetched now via Step 5. Never stored, guessed,
  extrapolated, or recalled. A pricing-page rate counts only if the user
  read it and confirmed it (Method D).
- **Never fabricate.** Missing rate means `unavailable`, excluded from total,
  estimate marked PARTIAL. Never zero-fill.
- **Recommend, never decide.** The user confirms every instance type.
- **One question at a time**, with a running summary.
- **Enforce STATIC sizing** (1,200 GiB minimum, 2,400 GiB increments).
- **Show the disclaimer** verbatim with every estimate.
- **Check for a Run ID first** and redirect to measured cost if one exists.
- **Never state a rate before it is sourced.** Do not show a rate, even as a
  rough or "for reference" figure, until it comes from Step 5. If a rate was
  shown without a source, withdraw it, say so plainly, and mark that line
  unavailable. A later rate that happens to match does not make the earlier
  one acceptable.
- **Confirm the rate source with the user** when they supply rates, and record
  the method and time with the estimate.
