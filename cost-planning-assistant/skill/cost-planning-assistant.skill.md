# Cost Planning Assistant — LLM Skill

A step-by-step SOP for an AI agent to guide a user through a **pre-run, what-if
cost estimate** for an AWS HealthOmics workflow. This is planning math — a
"what would this roughly cost if I ran it like so" answer — **not a bill, and
not a measured cost**. If the user already has a Run ID for a workflow that has
run or is running, this skill does not apply: route them to the **post-run
estimator** `dist-cost-estimator/estimate-run-cost.mjs <runId> --region <r>`
(or the dashboard's Run Detail "Estimated cost" panel), which prices *measured*
task data instead of assumptions.

This skill supports two ways to produce the numbers, in order of preference:

1. **Drive the bundled CLI** (`plan-cost.mjs --json`) when the agent can run
   `node`. The CLI is the **verified single source of truth** for both the
   live rates and the math.
2. **Direct-API mode** — when the agent *cannot* run `node` (some sandboxes
   cannot execute node or read shell profiles), the agent fetches live rates
   from the AWS Price List API itself and does the cost math by hand, using the
   exact query, parsing rules, and formulas transcribed below from the verified
   source. This stays honest only if the agent follows the rules exactly:
   **fetch live rates every time, never a frozen snapshot, never a fabricated
   number.**

Whichever path is used, the result must be identical in method to the CLI,
because the formulas and query in this skill are copied verbatim from the same
source the CLI runs (`src/estimationCore.mjs`, `src/priceList.mjs`,
`src/units.mjs`, `src/instanceSpecs.mjs`).

## The disclaimer (include this verbatim, every time an estimate is shown)

> ESTIMATE ONLY — NOT A BILL. This is a rough planning estimate computed from published AWS On-Demand list prices and the assumptions you supplied (runtime, scatter width, instance choice, storage mode and size). It excludes overhead, rounding, credits, discounts, Savings Plans, and Reserved pricing, and will differ from your actual AWS bill.

This is the exact text of `ESTIMATE_DISCLAIMER` in `src/estimationCore.mjs`.
The CLI returns it as the `disclaimer` field of every `--json` result and
prints it with every rendered estimate. Always show it — never paraphrase it
away.

**When the estimate was computed by the agent itself (direct-API mode), add
this note alongside the disclaimer:**

> Computed directly by the assistant from the live AWS Price List API, not via
> the verified `plan-cost.mjs` CLI. The method (rate query and formulas) is
> transcribed from that CLI's source, but if you can run the CLI, prefer it as
> the authoritative check.

## Step 1 — Check for a Run_Id first

Ask the user: **"Do you already have a Run ID for a workflow that has executed
or is executing?"**

- If **yes**: do not proceed with this skill. A *measured* post-run estimate is
  available — direct the user to:
  - `dist-cost-estimator/estimate-run-cost.mjs <runId> --region <region>`, or
  - the Run Detail "Estimated cost" panel in the dashboard.

  Stop here. Do not re-implement or approximate post-run estimation.

- If **no**: continue to Step 2. The user is planning a workflow that has not
  run yet, so every quantity (runtime, scatter width, instance choice, storage
  size) must come from the user as an explicit assumption — never infer it from
  a workflow definition, and never default it silently.

## Step 2 — Choose an execution mode (follow this ladder in order)

Before gathering the plan, determine how you will get the live rates and do the
math. Try these in order and use the first one that works. **Never skip ahead
to fabricating a rate.**

### (a) PREFERRED — drive the bundled CLI

Use this if **all** of the following hold:

- `node` is runnable (version ≥ 20 — check with `node --version`),
- dependencies are installed (run `npm ci` in `cost-planning-assistant/` if the
  `node_modules` directory is missing), and
- the environment has outbound network access to AWS.

Build the plan JSON and invoke the CLI non-interactively:

```bash
echo '{"region":"us-east-1","steps":[{"label":"align","instanceType":"omics.m.large","runtime":"45m","scatter":4}],"storage":{"mode":"STATIC","sizeGiB":100,"runtime":"6h"}}' \
  | node plan-cost.mjs --region us-east-1 --json
```

(or write the JSON to a file and use `--input <file> --json`). Treat the CLI's
`--json` output as the **sole source of numbers** — do not re-derive anything.
Present it per Step 7. This is the verified single source of truth; prefer it
whenever it is available.

### (b) DIRECT-API MODE — agent fetches rates and computes itself

Use this if you **cannot** run `node`, but you **do** have some authenticated,
read-only path to AWS, such as:

- the AWS CLI (`aws pricing get-products ...`),
- an AWS MCP tool that can call `pricing:GetProducts`, or
- an HTTP client with SigV4 signing, outbound network, and read-only
  `pricing:GetProducts` permission.

Fetch the live rate map with the exact query and parsing rules in **Step 6**,
then compute the estimate with the exact formulas in **Step 4**. You do the
math by hand here, so transcribe the formulas exactly — do not approximate.
Only read-only `pricing:GetProducts` is needed; never call any write or
`omics:*` operation.

### (c) LAST RESORT — ask the user to run the query

If you have **no** AWS access at all, give the user the exact
`aws pricing get-products` command from Step 6 to run themselves, ask them to
paste the raw output back, parse it per Step 6, then compute per Step 4.

**If none of (a), (b), or (c) can produce a live rate, say so plainly and
stop. Never invent, guess, or recall a rate from memory.**

## Step 3 — Gather the user's plan, one decision at a time

Collect, conversationally, one question at a time (do not dump every question
in a single message). Keep a running summary and show it back periodically.

1. **Region.** Ask which AWS region to price against. If the user doesn't know,
   mention it should match where they intend to run the workflow. (Note: the
   Price List API is queried in `us-east-1` regardless — see Step 6 — but you
   always filter by the *target* region's `regionCode`.)
2. **Steps.** For each step of the workflow:
   - Ask what the step does (a short label).
   - Ask if they know their resource need (min vCPU / min memory / whether a
     GPU is needed). If they give one, use the embedded **Instance spec table**
     (Step 5) to *recommend* the smallest-fitting instance type — but **never
     decide for the user**. Present the recommendation and let them confirm it
     or pick a different type.
   - Ask for the step's estimated **per-task** runtime (a duration, e.g.
     `"45m"`, `"1.5h"`) and its **scatter width** (how many parallel tasks run
     this step, e.g. one per sample).
   - Ask if there's another step to add; repeat.
3. **Storage.** Ask the user's preferred storage mode, briefly explaining:
   - **STATIC** = a fixed reserved capacity billed for the run duration
     (priced against the `Run Storage` rate).
   - **DYNAMIC** = usage-based billing (priced against the `Dynamic Run
     Storage` rate). The size here is a user-supplied *assumption*, not a
     measured value — say so when you present it.

   Then ask for the storage size (e.g. `"100GiB"`) and the run's overall
   expected wall-clock runtime (used to compute storage GB-hours).

### Unit conversions (from `src/units.mjs`)

Convert the user's inputs to the units the math expects. Fractions are allowed.

- **Durations → hours** (a unit suffix is required; `s`/`m`/`h`/`d`,
  case-insensitive):
  - `s` → ÷ 3600 (e.g. `90s` → `0.025h`)
  - `m` → ÷ 60 (e.g. `30m` → `0.5h`)
  - `h` → as-is (e.g. `1.5h` → `1.5h`)
  - `d` → × 24 (e.g. `2d` → `48h`)
- **Sizes → GiB** (`GiB` or `TiB`; a bare number defaults to GiB):
  - `GiB` → as-is (e.g. `500GiB` → `500`, `500` → `500`)
  - `TiB` → × 1024 (e.g. `0.5TiB` → `512`, `1TiB` → `1024`)

## Step 4 — The exact math (transcribed from `src/estimationCore.mjs`)

Do the math exactly this way. The one-minute floor is applied **per task,
before** multiplying by scatter width — this ordering matters and must match
the CLI.

**Constant:**

```
ONE_MINUTE_HOURS = 1 / 60   // = 0.016666… hours
```

**Per compute step** (given per-task runtime in hours, scatter width, and the
instance type's rate):

```
billedTaskHours = Math.max(perTaskRuntimeHours, ONE_MINUTE_HOURS)   // per task, BEFORE scatter
minimumApplied  = billedTaskHours > perTaskRuntimeHours             // note it when the floor raised the value
instanceHours   = billedTaskHours * scatterWidth
cost            = instanceHours * rate                              // rate is the instance type's Instance-hrs rate
```

**Storage** (given size in GiB, run wall-clock runtime in hours, and the
family rate):

```
family  = (mode === 'STATIC') ? 'Run Storage' : 'Dynamic Run Storage'
gbHours = sizeGiB * runWallClockHours
cost    = gbHours * familyRate                                      // familyRate is that family's GB-Hours rate
```

**Total (no-fabrication / partial-total rule):**

```
total   = sum of cost over ONLY the line items that have an available rate
partial = true if ANY line item has no available rate
```

If a rate is missing for a line item, mark that line **unavailable** (show `—`,
never `0`), exclude it from the total, and mark the whole estimate **PARTIAL**.
Never invent the missing number.

### Worked example (sub-minute task shows the floor applied per task)

A step with a per-task runtime of `30s` (= `0.5/60` = `0.008333…h`), scatter
width `4`, instance `omics.m.large` at a live rate of (for example)
`0.0726 USD/Instance-hr`:

```
perTaskRuntimeHours = 30 / 3600          = 0.008333… h
billedTaskHours     = max(0.008333…, 1/60) = 0.016666… h   // floor applied PER TASK (minimumApplied = true)
instanceHours       = 0.016666… * 4       = 0.066666… h    // THEN multiply by scatter width
cost                = 0.066666… * 0.0726  ≈ 0.00484 USD
```

Contrast: if you (incorrectly) multiplied runtime by scatter first and floored
after, you'd get `max(0.03333…, 0.016666…) = 0.03333…` → a different, wrong
number. The floor is **per task, before scatter**.

## Step 5 — Instance spec table (hardware specs; stable, not rates)

These are **fixed hardware specs** transcribed from `src/instanceSpecs.mjs`
(sourced from the AWS doc "Compute and memory requirements for HealthOmics
tasks"). They are **distinct from rates** — specs are stable and safe to embed,
but every **price** must still be fetched live (Step 6). The Price List API
does not reliably return vCPU/memory, which is exactly why this curated table
exists. Use it only to *recommend* the smallest-fitting type; never auto-select.

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

`omics.g6.*` — Nvidia L4:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g6.xlarge | 4 | 16 | 1 | 24 |
| omics.g6.2xlarge | 8 | 32 | 1 | 24 |
| omics.g6.4xlarge | 16 | 64 | 1 | 24 |
| omics.g6.8xlarge | 32 | 128 | 1 | 24 |
| omics.g6.12xlarge | 48 | 192 | 4 | 96 |
| omics.g6.16xlarge | 64 | 256 | 1 | 24 |
| omics.g6.24xlarge | 96 | 384 | 4 | 96 |

`omics.g6e.*` — Nvidia L40s:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g6e.xlarge | 4 | 32 | 1 | 48 |
| omics.g6e.2xlarge | 8 | 64 | 1 | 48 |
| omics.g6e.4xlarge | 16 | 128 | 1 | 48 |
| omics.g6e.8xlarge | 32 | 256 | 1 | 48 |
| omics.g6e.12xlarge | 48 | 384 | 4 | 192 |
| omics.g6e.16xlarge | 64 | 512 | 1 | 48 |
| omics.g6e.24xlarge | 96 | 768 | 4 | 192 |

`omics.g5.*` — Nvidia Tesla A10G:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g5.xlarge | 4 | 16 | 1 | 24 |
| omics.g5.2xlarge | 8 | 32 | 1 | 24 |
| omics.g5.4xlarge | 16 | 64 | 1 | 24 |
| omics.g5.8xlarge | 32 | 128 | 1 | 24 |
| omics.g5.12xlarge | 48 | 192 | 4 | 96 |
| omics.g5.16xlarge | 64 | 256 | 1 | 24 |
| omics.g5.24xlarge | 96 | 384 | 4 | 96 |

`omics.g4dn.*` — Nvidia Tesla T4:

| Instance type | vCPUs | Memory (GiB) | GPU count | GPU memory (GiB) |
|---|---|---|---|---|
| omics.g4dn.xlarge | 4 | 16 | 1 | 16 |
| omics.g4dn.2xlarge | 8 | 32 | 1 | 16 |
| omics.g4dn.4xlarge | 16 | 64 | 1 | 16 |
| omics.g4dn.8xlarge | 32 | 128 | 1 | 16 |
| omics.g4dn.12xlarge | 48 | 192 | 4 | 64 |
| omics.g4dn.16xlarge | 64 | 256 | 1 | 16 |

## Step 6 — Price List query + parsing rules (direct-API mode)

Transcribed from `src/priceList.mjs` / `ingest/src/cost/priceList.ts`. Fetch
the live rate map for the user's target region, then feed those rates into the
Step 4 math.

### The query

- **ServiceCode:** `AmazonOmics`
- **Filters** (both `TERM_MATCH`):
  - `regionCode` = the **target region** being priced (e.g. `us-west-2`)
  - `workflowType` = `Private`
- **Endpoint region:** the AWS Price List API only lives in `us-east-1`, so
  query the pricing service **in `us-east-1` regardless of the region being
  priced**. The region you are pricing is expressed through the `regionCode`
  filter, not the endpoint.
- **Pagination:** follow `NextToken` until it is absent; accumulate all pages.
- Read-only `pricing:GetProducts` only. No write calls, no `omics:*`.

AWS CLI form (fill in the target region in the `regionCode` filter):

```bash
aws pricing get-products \
  --region us-east-1 \
  --service-code AmazonOmics \
  --filters 'Type=TERM_MATCH,Field=regionCode,Value=us-west-2' \
            'Type=TERM_MATCH,Field=workflowType,Value=Private' \
  --output json
```

(Repeat with `--starting-token <NextToken>` until no `NextToken` is returned.)

Equivalent SDK / MCP call: invoke `pricing:GetProducts` with
`ServiceCode='AmazonOmics'` and the two `TERM_MATCH` filters above, against the
`us-east-1` pricing endpoint, paginating on `NextToken`. The response's
`PriceList` is an array of JSON payloads (see parsing note below).

### Parsing each `PriceList` entry

Each `PriceList` entry is a JSON payload. **Coerce it with `String(...)` before
`JSON.parse`** — the pinned SDK may hand back a boxed `String` object
(`typeof entry === "object"`), not a primitive string; `String(...)` normalizes
both. A payload that fails to parse is skipped (never zero-filled).

For each parsed product, keep it **only if all** of these hold:

1. `product.productFamily === "Compute"` (both compute and storage products use
   this family).
2. `product.attributes.resourceType` is a non-empty string.
3. The On-Demand rate exists at
   `terms.OnDemand.<firstTermKey>.priceDimensions.<firstDimKey>`, where that
   dimension has a string `unit` and a `pricePerUnit.USD` that parses to a
   finite number. (The `OnDemand` and `priceDimensions` maps are keyed by
   opaque SKU-derived ids — take the first entry of each.) Keep **only** the
   On-Demand `pricePerUnit.USD`.
4. The `unit` matches the family:
   - **COMPUTE:** `resourceType` is an omics instance type (e.g.
     `omics.m.large`) **and** `unit === "Instance-hrs"`.
   - **STORAGE:** `resourceType` is exactly `"Run Storage"` (STATIC) or
     `"Dynamic Run Storage"` (DYNAMIC) **and** `unit === "GB-Hours"`.

**Skip** everything else so it does not pollute the rate map: `Ephemeral
Storage`, sequence-store / annotation-store / variant-store products, Ready2Run
per-run products, and any product whose unit does not match its family.

Reduce the survivors into a rate map keyed by `resourceType`:
`{ "<resourceType>": { pricePerUnit: <number>, unit: "<Instance-hrs|GB-Hours>" } }`.
The currency is `USD`. Record the retrieval timestamp (the moment you fetched)
to show in the output. A `resourceType` with no surviving entry simply has **no
rate** — treat that line as unavailable in Step 4, never as `0`.

## Step 7 — Present the estimate as a clean table

Show the estimate as an aligned markdown table, with the disclaimer (and the
direct-API note if you computed it yourself). Columns:

| Usage | Quantity | Unit | Rate | Cost |
|---|---|---|---|---|
| align (omics.m.large ×4) | 0.0667 | Instance-hrs | 0.0726 USD | 0.00484 USD |
| Run Storage (100 GiB × 6h) | 600 | GB-Hours | <live> USD | <computed> USD |

Then show:

- **TOTAL** — the sum of only the available line items.
- **Region** — the target region priced.
- **Currency** — `USD`.
- **Rate-retrieved** — the timestamp the live rates were fetched.
- **PARTIAL badge** — if any line item had no rate, mark the estimate
  `PARTIAL` and list which line(s) are unavailable.

Surface any unavailable line honestly: show `—` (never `0`) for its rate and
cost, and state plainly why (e.g. "no published rate was found for
`omics.x.large` in `us-west-2`, so that line is excluded from the total").

After presenting, ask if the user wants to change anything (a different
instance type, runtime, scatter width, storage size, or mode). If so, update
just that part of the plan and re-estimate — do not make them start over.

## Summary of rules this skill always follows

- **Fetch live rates.** Every rate comes from a live Price List query (via the
  CLI, a direct API call, or the user running the query) — never a frozen
  snapshot, never a number recalled from memory.
- **Never fabricate.** A missing rate or unknown spec is an explicit
  unavailable state (`—`), excluded from the total, which is then marked
  `PARTIAL`. Never guess, default, or zero-fill a number.
- **Recommend, never decide.** A suggested instance type always requires the
  user's explicit confirmation or override.
- **Show the disclaimer** with every estimate — verbatim — plus the direct-API
  note when the agent computed the estimate itself.
- **Surface unavailable state** as-is; show `—`, not `0`, and explain why.
- **Let the user revise** and re-estimate without restarting.
- **Check for a Run_Id first** and hand off to the post-run estimator if one
  exists.
- **Prefer the CLI** when node is available — it is the verified single source
  of truth; direct-API mode mirrors it exactly, it does not replace it.
