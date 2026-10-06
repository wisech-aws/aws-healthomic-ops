# Design: SQS FIFO buffer + batch-consumer ingest

Status: **IMPLEMENTED (buffer mechanism = Kinesis, not SQS FIFO) — deployed idle**
Owner: (you)
Related: `docs/healthomics-eventbridge-feedback.md` (the event-field asks that would
make most of this unnecessary if HealthOmics adopts them).

> ## UPDATE (decision changed after review): Kinesis Data Streams, not SQS FIFO
>
> This doc was drafted around **SQS FIFO**, but during implementation we hit a
> hard EventBridge limitation and, after evaluating alternatives, switched the
> **buffer mechanism to Amazon Kinesis Data Streams**. Everything else in the
> design below still holds (batched consumer, ReportBatchItemFailures,
> terminal-only enrichment, DynamoDB ordering guards kept authoritative,
> additive toggle, migration/rollback). Only the buffer + delivery mechanism
> changed. Why:
>
> - **EventBridge → SQS FIFO cannot set `MessageGroupId` per event.** The rule's
>   `SqsParameters.MessageGroupId` is a STATIC string — `$.detail.runId` renders
>   literally, forcing every event into ONE group (full serialization, worse
>   than today). Confirmed by CloudFormation synth.
> - Getting per-run grouping with SQS FIFO would require either a **thin enqueue
>   Lambda** (adds a per-event Lambda invocation — reintroduces the exact
>   concurrency-management surface we're removing) or **EventBridge Pipes** (which
>   cannot take the event bus as a source, so it needs a bridging standard queue
>   → more infra + a hop).
> - **EventBridge → Kinesis DOES support a native dynamic PartitionKey**
>   (`PartitionKeyPath = $.detail.runId`). Keying by runId puts a run's events on
>   one shard (in-order per run, parallel across runs) with **no enqueue Lambda,
>   no bridging queue, no extra concurrency knob** — the cleanest topology.
> - Kafka/MSK and Redis were rejected: always-on, need glue, add stateful ops
>   burden — over-engineered for this.
> - **Tradeoff accepted:** Kinesis does NOT scale to zero (~$30/mo idle for an
>   on-demand stream) vs. SQS's true $0 idle. Judged worth it for the clean
>   topology and large-batch throughput; ~$30/mo is minimal.
>
> **Final topology:**
> ```
> HealthOmics → EventBridge rule (source=aws.omics)
>             → Kinesis Data Stream (on-demand, PartitionKey = $.detail.runId)
>             → batch-consumer Lambda (kinesisHandler.ts → shared getDefaultHandler)
>                  KinesisEventSource: batchSize 100, ReportBatchItemFailures,
>                  bisectBatchOnError, retryAttempts 5, maxRecordAge 1h,
>                  onFailure → SQS DLQ
>             → per-item conditional UpdateItem + publish (DynamoDB guards unchanged)
> ```
>
> **Toggle (additive, single-change cutover/rollback):** CDK context
> `-c kinesisIngestMode=off|present|active`.
>   - `off` (default): only the direct EventBridge → Lambda path.
>   - `present`: Kinesis stream + consumer + ESM deployed but IDLE; EventBridge
>     still targets the Lambda. (Current dev state — validated.)
>   - `active`: EventBridge targets the Kinesis stream; consumer is the live
>     ingest path. Roll back to `present`/`off` with one redeploy.
>
> **Consumer scaling vs. enrichment TPS:** Kinesis consumer concurrency =
> shards × parallelization factor (on-demand auto-scales shards). Enrichment
> (terminal-only GetRunTask) stays within the ~10 TPS HealthOmics run-read
> bucket via the per-instance limiter governor (`OMICS_TPS`), independent of
> shard fan-out. Ordering correctness remains at the DynamoDB monotonic + status
> guards; per-shard order merely reduces how often they must correct.
>
> **Note:** `scripts/deploy.sh` does not forward `-c` context; deploy the
> toggle with `npx cdk deploy HealthOmicsIngest -c kinesisIngestMode=<mode>`
> directly (a follow-up could add a `--kinesis-mode` flag to the script).
>
> The SQS-FIFO-specific sections below (§4.1 queue config, MessageGroupId, dedup)
> are RETAINED for historical context / the rejected-alternative record; read
> them as "why not SQS FIFO."

## 1. Why

Operating the dashboard at batch scale (100+ concurrent runs, ~200 tasks each)
exposed two distinct bottlenecks in the current
`EventBridge → Lambda (per event)` pipeline:

1. **Invocation / write throughput.** EventBridge invokes the ingest Lambda
   **once per event**. A 100-run batch emits ~80,000 events; even the cheap
   status-only writes (PENDING/STARTING) saturate Lambda reserved concurrency,
   producing a growing backlog (measured freshness lag grew to **~55–103 min**
   at 100 concurrent runs before mitigation, and ~4 min even after raising
   concurrency to 200–400).
2. **Enrichment rate ceiling.** `GetRun`/`GetRunTask`/`ListRunTasks` share a
   **10 TPS** HealthOmics quota. The current per-Lambda-instance token-bucket
   limiter only *approximates* a fleet cap (`reservedConcurrency × OMICS_TPS`);
   at high concurrency it overshoots and self-inflicts `ThrottlingException`s.

This design addresses **bottleneck #1 fully** and gives **cleaner control over
#2**, but does **not** raise the 10 TPS enrichment ceiling (see §9).

## 2. What changes (summary)

```
BEFORE:  HealthOmics → EventBridge (source=aws.omics) → Lambda (1 invoke/event)
                                                        → per-item conditional
                                                          UpdateItem + publish

AFTER:   HealthOmics → EventBridge (source=aws.omics)
                     → SQS FIFO (high-throughput, MessageGroupId = runId,
                                 content dedup)
                     → Batch-consumer Lambda (batch of N msgs/invoke,
                                 ReportBatchItemFailures,
                                 ESM maximumConcurrency = fleet cap)
                     → per-item conditional UpdateItem + publish
                       (ordering stays at DynamoDB — unchanged guards)
```

Key properties retained from today:
- **Ordering correctness stays at DynamoDB** — the monotonic `updatedAt` guard
  and the status-monotonic terminal guard on `conditionalPut` are unchanged.
  FIFO-per-run is a *helpful* ordering aid but we do NOT rely on it for
  correctness (decision: keep guards authoritative). Consequently we do **NOT**
  use `BatchWriteItem` (it cannot carry `ConditionExpression`).
- **DynamoDB single-table model, GSI1/GSI2, Run_Summary, Group_Registry** — all
  unchanged.
- **Deferred re-sweep (Reconciler)** — unchanged; still the late-settling
  backstop.

## 3. Enrichment policy (finalized)

Only the events that add renderable data trigger a HealthOmics read; the event
payloads carry only identifiers + status (verified from raw logs), so:

| Event         | Consumer action                                              | GetRunTask? |
|---------------|--------------------------------------------------------------|-------------|
| PENDING       | dropped at the EventBridge rule (adds nothing)               | No          |
| STARTING      | status-only conditional write + publish                      | No          |
| RUNNING       | status-only write; set approximate `startedAt = event.time`  | No          |
| **terminal**  | **the one authoritative enrichment**: GetRunTask → name,     | **Yes (1)** |
| (COMPLETED/   | cpus, memory, instanceType, startTime, stopTime,             |             |
|  FAILED/      | failureReason, statusMessage; overwrites the approximate     |             |
|  CANCELLED)   | startedAt with the authoritative value                       |             |

Result: **~1 enrichment call per task**, on the terminal event. This halves the
load on the 10 TPS bucket vs. the earlier RUNNING+terminal policy.

Live-view tradeoff (accepted): a RUNNING task shows correct **status/DAG color**
and an **approximate start time**, but its **name and resource sizes appear only
when it reaches terminal** (when the single enrichment runs). The DAG topology +
status is live; per-task metadata fills in at completion. The deferred re-sweep
guarantees final authoritative values.

Safety net: if a terminal task's stored record has no `startedAt` (it never got
a RUNNING event — e.g. a very fast task), the terminal enrichment is the first
and only read and captures everything, so nothing is lost.

## 4. Component design

### 4.1 SQS FIFO queue
- **Type:** FIFO, **high-throughput mode** (`FifoThroughputLimit=perMessageGroupId`,
  `DeduplicationScope=messageGroup`). HT-FIFO parallelizes across MessageGroupIds
  → thousands of `runId` groups give the throughput we need (default FIFO's
  3,000 msg/s batched is too low for ~1,000-run bursts; HT-FIFO scales far
  higher across groups).
- **MessageGroupId = `runId`** — in-order per run, parallel across runs.
- **Deduplication:** content-based dedup (`ContentBasedDeduplication=true`) OR an
  explicit `MessageDeduplicationId` from the EventBridge event `id` if
  passthrough is supported (preferred — avoids the 5-min body-hash window edge
  case). CONFIRM during implementation which EventBridge → SQS FIFO dedup path
  is available.
- **Visibility timeout:** ≥ 6× the consumer Lambda timeout (AWS guidance).
- **Redrive → DLQ:** `maxReceiveCount` (e.g. 5) → an SQS DLQ (replaces / augments
  the current EventBridge DLQ). A message that repeatedly fails lands in the DLQ
  rather than blocking its `runId` group forever (see §6).

### 4.2 EventBridge rule
- Rule pattern: `{"source":["aws.omics"]}` PLUS a filter to **drop PENDING task
  events** (and any other status we don't persist) so they never enter the
  queue — e.g. match on `detail.status` excluding PENDING for task events. (Run
  events and non-PENDING task events pass.)
- Target: the SQS FIFO queue, with `SqsParameters.MessageGroupId` = `$.detail.runId`.
- Keeps the existing IAM least-privilege posture (EventBridge → SQS SendMessage
  on the one queue).

### 4.3 Batch-consumer Lambda (event source mapping)
- **Trigger:** SQS FIFO via ESM.
- **Batch size:** start at **10** (FIFO caps at 10/group/poll) with a short
  **batch window** (e.g. 1–2s) to accumulate.
- **`functionResponseType: ReportBatchItemFailures`** — return only the failed
  message IDs so successful ones are deleted and only failures redrive. CRITICAL
  for FIFO: a thrown error would otherwise reprocess/block the whole group.
- **`maximumConcurrency` (ESM scaling control):** this becomes the **clean fleet
  cap**. Set it so the fleet-wide GetRunTask rate stays ≤ enrichment budget.
  This REPLACES the fragile per-instance `reservedConcurrency × OMICS_TPS`
  approximation with an actual concurrency ceiling on the consumer.
- **Per-message processing (unchanged core logic):** map event → (enrich only if
  terminal) → **conditional `UpdateItem`** (monotonic + status guard) → publish.
  Reuses the existing `handler.ts` pipeline nearly verbatim; the wrapper changes
  from "1 EventBridge event" to "loop over SQS batch records, collect failures."

### 4.4 Rate limiting under the new model
- With ESM `maximumConcurrency = M` and terminal-only enrichment, the max
  concurrent GetRunTask callers = M. To stay ≤10 TPS: keep the per-instance
  limiter at `10 / M` TPS as a secondary guard, OR (cleaner) rely on
  `maximumConcurrency` being low enough that even unpaced it stays near budget.
  RECOMMENDATION: keep a light per-instance limiter as defense-in-depth but let
  ESM `maximumConcurrency` be the primary control — it's a true cap, unlike the
  per-instance approximation.
- (Future: a sharded-DynamoDB distributed token bucket if we ever need high
  consumer concurrency AND tight fleet rate simultaneously. Not needed for v1.)

## 5. Ordering (why DynamoDB guards stay)
- Decision: **do not move correctness to FIFO+in-memory collapse.** FIFO
  per-`runId` ordering plus at-least-once redelivery still has the sub-second /
  same-second residual we documented; the DynamoDB monotonic + status-monotonic
  guards already handle *any* order correctly and are proven. FIFO simply makes
  reordering rare, reducing how often the guards must correct.
- Net: correctness is unchanged and independently robust; FIFO is an
  optimization, not a dependency.

## 6. Failure handling
- **Per-message failure:** captured via `ReportBatchItemFailures`; only failed
  IDs redrive. Enrichment-incomplete terminal tasks still throw for that message
  → redrive → eventually SQS DLQ.
- **FIFO group-blocking risk:** a persistently-failing message blocks its
  `runId` group (FIFO won't advance past it). Mitigations: (a) `maxReceiveCount`
  → DLQ so it stops blocking after N attempts; (b) make the consumer resilient
  (it already treats enrichment failure as retryable and publish failure as
  non-fatal). Monitor DLQ depth (must trend 0).
- **Poison message:** lands in DLQ; alarm on DLQ `ApproximateNumberOfMessages`.

## 7. IAM / least-privilege deltas
- EventBridge role: `sqs:SendMessage` on the one FIFO queue (replaces
  `lambda:InvokeFunction` target).
- Consumer Lambda role: `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` on
  the queue + existing DynamoDB/AppSync/omics grants (unchanged).
- No new wildcards.

## 8. Cost impact (rough, at 100k runs/month)
- **SQS FIFO:** ~$0.50/million requests (FIFO). ~12.4M sends + receives + deletes
  ≈ tens of millions of requests → order **$15–30/month**. New line item.
- **Lambda:** FEWER invocations (batch of ~10 → ~10× fewer) → ingest Lambda cost
  **drops**, partially offsetting SQS.
- **DynamoDB / AppSync:** unchanged (same per-item writes/publishes).
- Net: modest new SQS cost, largely offset by fewer Lambda invocations. Still
  scales to zero at idle (SQS empty = no cost). Update the README cost section.

## 9. What this does NOT solve (explicit)
- **The 10 TPS enrichment ceiling is unchanged.** Terminal enrichment is still
  ≤10 GetRunTask/sec fleet-wide. A wave of N terminal tasks still takes ~N/10
  seconds to enrich. SQS buffers it cleanly (no loss, no overshoot) and the
  dashboard's *status* stays near-real-time, but enriched fields (name, cpus,
  memory, exact timing) on a huge simultaneous completion wave still fill in over
  minutes. Only the **HealthOmics run-read TPS quota increase** (10→20+, being
  filed) or **HealthOmics adding fields to the events** (see feedback doc)
  removes this ceiling.

## 10. Migration & rollback
- **Additive first:** create the queue + consumer Lambda alongside the existing
  path; do NOT remove the current EventBridge→Lambda target until the new path
  is validated.
- **Cutover:** switch the EventBridge rule target from the Lambda to the SQS
  queue (single rule change). The consumer Lambda reuses the existing handler
  logic, so behavior is identical downstream.
- **Rollback:** point the EventBridge rule target back at the Lambda; the queue
  drains and is idle. Fully reversible via one target change.
- **Validation gates before cutover:** (a) freshness-lag probe (event.time →
  processed) stays low under a 100-run batch; (b) DLQ = 0; (c) HealthOmics
  ThrottlingException ≤ prior; (d) 0 stuck tasks; (e) reconciler unaffected.

## 11. Open items to confirm during implementation
1. EventBridge → SQS FIFO: exact `MessageGroupId` JSON-path syntax and whether
   `MessageDeduplicationId` can be sourced from the event `id` (else use
   content-based dedup).
2. ESM `maximumConcurrency` minimum is 2; pick the value that bounds GetRunTask
   ≤ budget with terminal-only enrichment.
3. Whether to retire the EventBridge DLQ in favor of the SQS redrive DLQ (avoid
   two DLQs).
4. Batch window vs. latency: larger window = fewer invocations but more
   per-event lag; tune against the freshness-lag target (~seconds).
5. Test strategy: batch-record loop + partial-failure reporting need new unit
   tests; the core map/enrich/upsert/publish logic is already covered.

## 12. Decision log
- Ordering: **stays at DynamoDB conditional writes** (not FIFO+in-memory). ✓
- Partial-batch failure: **`ReportBatchItemFailures`**. ✓
- Enrichment: **terminal-only** (1 call/task); RUNNING sets approximate
  `startedAt` from event.time; stopTime from authoritative terminal GetRunTask.
  ✓  (Note: an earlier idea to derive stopTime from the terminal *event.time*
  and skip terminal enrichment was set aside — terminal IS the enrichment point,
  so stopTime comes authoritatively from GetRunTask.)
- Queue: **SQS FIFO high-throughput, MessageGroupId = runId**. ✓
- Rate control: **ESM `maximumConcurrency`** as primary; per-instance limiter as
  defense-in-depth. ✓
