# Fixtures

Sample data used by tests and the local verification script.

- `events/` — sample `aws.omics` EventBridge events (Requirement 13.2):
  - `events/run-status-change.json` — a "Run Status Change" event.
  - `events/task-status-change.json` — a "Task Status Change" event (the task id is carried in the task `arn`).

  These match the event shape assumed by `ingest/src/eventMapper.ts` and are consumed by `scripts/send-event.mjs` (Req 13.4).
- `definitions/` — sample workflow definition files, one per language: WDL, Nextflow, CWL. Populated in later tasks (Requirement 13.3).

These fixtures isolate all assumptions about the real HealthOmics event/definition shapes so they can be corrected in one place once confirmed against AWS documentation.
