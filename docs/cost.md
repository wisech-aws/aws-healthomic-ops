# Cost model

This page estimates what the dashboard itself costs to run. It does not cover
AWS HealthOmics workflow execution (compute and run storage), which is a
separate and usually much larger spend. The [README](../README.md#cost) has
the summary.

All prices are us-east-1 list prices at the time of writing, with no free tier
or discounts applied. Check current prices before relying on them.

## Fixed charges

Most components are billed per request or per GB and cost nothing at idle,
so the default configuration (`kinesisIngestMode=off`) has near-zero idle
cost. Two items are not request-driven:

- Amazon Kinesis Data Streams, only when the optional Kinesis buffer is
  enabled (`kinesisIngestMode=active` or `present`). An on-demand stream in On-demand Standard mode bills a fixed
  charge per stream-hour, about $0.04/hour, or roughly $29/month, plus about
  $0.08 per GB written and $0.04 per GB read. Sources:
  [Kinesis Data Streams pricing](https://aws.amazon.com/kinesis/data-streams/pricing/)
  and [Kinesis capacity modes](https://docs.aws.amazon.com/streams/latest/dev/how-do-i-size-a-stream.html).
  The pricing page renders its rate tables in the browser, so confirm the
  current per-stream-hour rate there. The account-level On-demand Advantage
  mode drops the per-stream charge but commits the account to at least
  25 MiB/s of ingest and retrieval, which is far above this workload.
- Data-proportional storage: DynamoDB items, point-in-time recovery (PITR)
  backups, CloudWatch Logs storage, and a few MB of SPA assets in Amazon S3.
  These trend to zero as stored data does, but they are not request-driven.

On the default direct path every event is its own ingest Lambda invocation,
which puts pressure on Lambda concurrency during large batches (the direct
ingest Lambda reserves 400). Enabling Kinesis absorbs those bursts in exchange
for the fixed stream charge. Switching back to `off` does not delete an
existing stream; see [Teardown](../README.md#teardown).

The Amazon Cognito user pool uses the Plus feature plan (for threat
protection), which bills $0.020 per monthly active user with no free tier. A
pool with no sign-ins in a month costs nothing; an admin-only pool with a few
users costs cents.

## Cost drivers

| Cost driver | Billing unit | Idle behavior |
|-------------|--------------|---------------|
| Kinesis Data Streams (on-demand, optional) | Per stream-hour, plus per GB written and read | Fixed charge while the stream exists (only when Kinesis is enabled). |
| AWS AppSync requests | Per million queries and mutations | Billed per request. |
| AppSync real-time subscriptions | Per connection-minute and per message | Billed while clients are connected. |
| AWS Lambda | Per request and GB-second | Billed per invocation. |
| Amazon DynamoDB reads and writes (on-demand) | Per read and write request unit | Billed per request. |
| DynamoDB storage and PITR | Per GB-month | Proportional to stored data. |
| Amazon CloudWatch Logs | Per GB ingested and GB-month stored | One `ingest_event` line per event, plus Lambda platform lines. Log groups never expire by default. |
| Amazon CloudFront | Per GB out and per 10,000 requests | Billed per request. |
| Amazon S3 (SPA assets) | Per GB-month and per request | A few MB stored. |
| Amazon SQS dead letter queues | Per million requests | Billed only when messages land. |
| Amazon EventBridge (`aws.omics`, default bus) | AWS service events on the default bus | Not billed. |
| EventBridge Scheduler (deferred re-sweep, direct path only) | Per million invocations | One one-shot schedule per terminal run. |
| Reconciler Lambda (deferred re-sweep, direct path only) | Per request and GB-second | One invocation per terminal run. |

## Estimate at 100,000 runs a month

The inputs were measured on a reference deployment:

- Run item in DynamoDB: about 3.6 KB, of which `rawGetRun` (the raw `GetRun`
  response) is about 2.7 KB.
- Task item in DynamoDB: about 0.29 KB.
- Tasks per run: about 40 (an `nf-core-fetchngs` sample run).
- SPA payload per fresh page load: about 3.3 MB (JS and CSS, uncompressed).

Modeling assumptions: each run emits about 4 run-status events and each task
about 3 task-status events. Every event is processed by ingest (DynamoDB
upserts and one AppSync publish fanned out to subscribers). In the default
`event` enrichment mode, HealthOmics read APIs are called at run start and
end and for failed tasks, not per event. At 40 tasks a run that is about 124
writes and 124 publishes per run, or about 12.4 million of each across 100,000
runs.

| Service | Basis | Est. monthly |
|---------|-------|--------------|
| DynamoDB writes | ~13.6M write units (run and task upserts) | ~$17 |
| DynamoDB reads | Ingest reads and dashboard queries | ~$1–3 |
| DynamoDB storage | ~1.5 GB (100k runs, ~4M tasks) | ~$0.40 |
| DynamoDB PITR | Continuous backup of ~1.5 GB | ~$0.30 |
| Lambda (ingest) | ~12.4M invocations, ~200 ms at 192 MB (direct ingest Lambda): ~465k GB-seconds (~$7.75) plus requests (~$2.50) | ~$10 |
| CloudWatch Logs | ~12.4M `ingest_event` lines plus Lambda platform lines, a few GB ingested | ~$2–5 |
| AppSync requests | ~12.4M publish and query operations | ~$50 |
| AppSync real-time | Connection-minutes and ~12.4M messages | ~$25–40 |
| CloudFront | SPA loads (~3.3 MB each), light viewer traffic | ~$15 |
| S3 (SPA assets) | A few MB stored, plus GETs | ~$0.10 |
| Cognito (Plus plan) | Tens of monthly active users at $0.020 | ~$0.10–2 |
| EventBridge (`aws.omics`) | AWS-source events on the default bus | $0 |
| SQS dead letter queues | Only on failure | ~$0 |
| Re-sweep: EventBridge Scheduler | ~100k one-shot schedules at ~$1/M | ~$0.10 |
| Re-sweep: Reconciler Lambda | ~100k invocations, ~10 s at 128 MB | ~$2 |
| Re-sweep: extra DynamoDB writes | ~41 rewrites per run (tasks and summary), ~4.1M write units | ~$5 |
| Re-sweep: CloudWatch `GetMetricData` | ~200k requests (2 metric families per run) | ~$1–3 |
| Total, default (`off`) | Sum of the rows above | ≈ $129–153 |

With the optional Kinesis buffer (`kinesisIngestMode=active`), start from the
default total, add the stream, swap the direct ingest Lambda row for the
Kinesis consumer Lambda, and drop the re-sweep rows, because the re-sweep does
not run on the Kinesis path today:

| Service | Basis | Est. monthly |
|---------|-------|--------------|
| Total, default (`off`) | From the table above | ≈ $129–153 |
| Kinesis Data Streams (optional) | 730 stream-hours at about $0.04, plus about 12 GB written and read | +$30–31 |
| Lambda (direct ingest) | Removed: the consumer processes these events instead | −$10 |
| Lambda (Kinesis consumer) | 192 MB, batched, so at most ~12.4M events at ~200 ms | +$10 (upper bound) |
| Re-sweep rows | Not run on the Kinesis path (Scheduler, Reconciler, extra writes, `GetMetricData`) | −$8–10 |
| Total, `active` | $129–153 + $30–31 − $10 + $10 − $8–10 | ≈ $151–174 |

## Sensitivities

- Tasks per run is the main lever. Real nf-core pipelines often run 100–200+
  tasks per run, which scales AppSync, Lambda, DynamoDB writes, and logs in
  proportion. At about 150 tasks per run the total is roughly $300–450 a
  month. The optional Kinesis stream-hour charge does not scale with tasks.
- AppSync is the largest item (about $75–90 combined), because every run and
  task status event is published and fanned out to subscribers.
- `rawGetRun` roughly quadruples the run-item write cost (a 3.6 KB item uses 4
  write units instead of 1). It is cheap in absolute terms, but dropping the
  raw capture would cut run-write cost about 4×.
- CloudFront scales with viewers and refreshes, not run count. The SPA bundle
  is large (about 3.3 MB), so code-splitting would reduce transfer.
- The deferred re-sweep (direct path only) adds about $8–10 a month at 100,000
  runs, mostly from extra DynamoDB writes. It scales with run count and tasks
  per run. Changing `RECONCILE_DELAY_MINUTES` does not change cost.
- Event-driven enrichment keeps HealthOmics read calls low: 2 calls for a
  207-task nf-core/rnaseq run in `event` mode, compared with 217 under the
  legacy `api` mode.
- These figures are planning estimates. Actual bills vary with pricing,
  region, free-tier eligibility, and traffic.
