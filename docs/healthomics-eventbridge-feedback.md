# Feedback: AWS HealthOmics EventBridge run/task status-change events

Feedback for the AWS HealthOmics / EventBridge service team, based on building
and operating an event-driven dashboard that ingests `aws.omics` status-change
events at batch scale. Every point below is grounded in behavior we measured
and instrumented.

## Context

We built an event-driven dashboard that ingests HealthOmics `aws.omics` **run**
and **task status-change events** from the default EventBridge bus into a
Lambda, enriches via the HealthOmics read APIs (`GetRun` / `ListRunTasks` /
`GetRunTask`), and persists to DynamoDB for a near-real-time UI. We ran repeated
batches of **3–40 concurrent runs** (nf-core-rnaseq ~207 tasks/run,
nf-core-fetchngs), producing bursts of **~1,900+ task events in a 6-minute
window**. The following are the concrete challenges we hit, in priority order,
with the impact and the workarounds we had to build for each.

## 1. Events are delivered out of order, with no per-resource sequencing

**Observation.** For a single task we logged the delivery order (from CloudWatch,
by `event.time`):

```
PENDING(12:28:12) → STARTING(12:28:21) → RUNNING(12:29:09) → COMPLETED(...) → RUNNING(12:29:09, redelivered)
```

A `RUNNING` event was frequently **processed after** the task had already
reached `COMPLETED`. Because our persistence was last-writer-wins, this left
tasks stored as `RUNNING` even though they had a `stoppedAt` — a visibly "stuck"
task in the UI while the run showed complete.

**Impact.** This was the single largest source of data-correctness bugs for us.
On a pre-mitigation 20-run batch we measured **60–78 tasks per batch** left in an
inconsistent non-terminal state.

**What would help from the service:**

- A **monotonic per-resource sequence number** on each event (e.g. a `sequence`
  or `version` field on the `detail`), so consumers can discard stale updates
  deterministically. `event.time` is insufficient (see #2).
- Optionally, documenting the ordering guarantee explicitly (we assume
  at-least-once, unordered — confirming that would help consumers design
  correctly rather than discover it empirically).

## 2. `event.time` has only 1-second resolution — insufficient to order events

**Observation.** Multiple lifecycle transitions for the same task routinely carry
the **same whole-second `event.time`** (e.g. two `RUNNING` deliveries and the
`COMPLETED` all at `12:29:09`). We also saw `event.time` values that did not
increase monotonically with the true transition order.

**Impact.** Even when we tried to order by `event.time`, same-second collisions
made it ambiguous which of `RUNNING`/`COMPLETED` was authoritative. We could not
build a reliable "keep the latest" rule from timestamps alone.

**What would help:** millisecond (or finer) precision on `event.time`, and/or the
monotonic sequence field from #1.

## 3. At-least-once delivery produces duplicate events, including duplicate re-deliveries of an *earlier* state

**Observation.** We saw the same `RUNNING` event delivered 2–3 times, and —
critically — a duplicate `RUNNING` arriving *after* the terminal event.
Duplicates of the current state are harmless and expected; duplicates of a
**superseded** state are what caused reversions.

**Impact.** Combined with #1/#2, redelivered stale events overwrote correct
terminal state.

**What would help:** a stable, documented **idempotency / event id** that is
identical across redeliveries of the *same* event (so consumers can dedup),
distinct from a new transition. We use the EventBridge `id`, but it wasn't clear
whether it is stable across redeliveries of the same underlying state change.

## 4. Task events carry no `taskId` field — the task identity is only in the ARN

**Observation.** The task "Task Status Change" `detail` has no dedicated
`taskId`; we parse it from the trailing segment of the task `arn`
(`.../task/<id>`).

**Impact.** Minor but fragile — a change to ARN formatting would silently break
task identity extraction. We isolated it behind a single parser with a "confirm
against docs" marker.

**What would help:** a first-class `taskId` field in the task event `detail`.

## 5. Utilization metrics lag the terminal event by tens of seconds to minutes

**Observation.** HealthOmics emits CPU/memory utilization to CloudWatch at ~30s
intervals, and the metrics for the final portion of a run are not queryable at
the instant the terminal event arrives. When we computed a per-run summary on
the terminal event, utilization was frequently empty even though the data landed
1–5 minutes later.

**Impact.** Our "at terminal" rollup recorded "utilization unavailable" for runs
that actually had data. We had to build a **deferred re-sweep** (a one-shot
scheduler that re-reads state + re-queries CloudWatch ~5 minutes after terminal)
purely to work around the settling lag — added infrastructure and ~$8–10/month
at 100k runs.

**What would help:**

- A signal (event or field) indicating **metrics are complete / flushed** for a
  run, or
- A terminal event emitted (or a "run fully settled" event) only once
  utilization is queryable, so consumers don't need a guess-and-retry delay.

## 6. Enrichment API returns a terminal state for an event whose status is non-terminal

**Observation.** When we enriched a late-delivered `RUNNING` task event via
`GetRunTask`, the API (correctly) returned the *current* authoritative state —
`COMPLETED` with a `stopTime`. So the event said `RUNNING` but the read API said
`COMPLETED`. This is actually the *correct* behavior of the read API, but it
means **the event status cannot be trusted over the enrichment** for late
events.

**Impact.** We had to add an "authoritative-terminal-override": when enrichment
reports terminal but the event says non-terminal, trust the enrichment. This
works well, but it means every consumer that both listens to events and enriches
must independently discover and handle this.

**What would help:** guidance in the docs that the read APIs are authoritative
and event status may be stale, so consumers prefer enrichment on conflict.

## Summary of the consumer burden

To ingest these events correctly at batch scale we had to build, specifically
because of the above:

- a **status-monotonic upsert guard** (terminal state can't be reverted to
  non-terminal),
- an **authoritative-terminal-override** (trust `GetRunTask` over a stale event),
- a **field-merge persistence** model (so a sparse / stale event can't blank
  enriched fields),
- a client-side **10 TPS rate limiter + reserved concurrency** to survive
  enrichment amplification without self-inflicting `ThrottlingException`, and
- a **deferred re-sweep** (scheduler + reconciler Lambda) to handle
  late-settling task states and metric lag.

Most of this complexity would be unnecessary with **(a) a per-resource monotonic
sequence number and (b) millisecond `event.time`**, which together would let any
consumer implement a simple, correct "latest wins" rule. Those two changes would
have the highest impact for us.

## What worked well

- The default-bus, zero-config `source: aws.omics` delivery is genuinely nice —
  no producer-side wiring needed.
- The read APIs (`GetRun` / `ListRunTasks` / `GetRunTask`) are authoritative and
  complete; enrichment-on-conflict is a reliable fallback.
- Event schema is otherwise stable and well-formed.

## Highest-impact asks (TL;DR)

1. **Monotonic per-resource sequence number** on each status-change event.
2. **Millisecond-precision `event.time`.**
3. A **metrics-settled signal** (or terminal event emitted only once utilization
   is queryable).
4. First-class **`taskId`** in the task event `detail`.
