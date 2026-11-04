/**
 * Real HealthOmics EventBridge events captured from run 8508632
 * (nf-core-rnaseq v2-wave-fix, 207 tasks). The fixture holds all 5 run events
 * plus every event (PENDING, STARTING, RUNNING, COMPLETED) of 12 representative
 * tasks, in arrival order, with the account id redacted to 123456789012.
 * Task 6725384 has PENDING and STARTING in the same second (event.time).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBridgeEvent } from 'aws-lambda';

export type OmicsEvent = EventBridgeEvent<string, Record<string, unknown>>;

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'run-8508632-subset.jsonl',
);

export const REPLAY_RUN_ID = '8508632';
/** The task whose PENDING and STARTING events share one event.time second. */
export const SAME_SECOND_TASK_ID = '6725384';

/** All fixture events in arrival order (fresh copies on every call). */
export function loadReplay(): OmicsEvent[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as OmicsEvent);
}

export function runEvents(): OmicsEvent[] {
  return loadReplay().filter((e) => e['detail-type'] === 'Run Status Change');
}

export function allTaskEvents(): OmicsEvent[] {
  return loadReplay().filter((e) => e['detail-type'] === 'Task Status Change');
}

/** The task id (trailing ARN segment) of a task event. */
export function taskIdOf(event: OmicsEvent): string {
  const arn = String(event.detail.arn);
  return arn.slice(arn.indexOf('task/') + 'task/'.length);
}

/** Every task event with the given status. */
export function taskEvents(status: string): OmicsEvent[] {
  return allTaskEvents().filter((e) => e.detail.status === status);
}

/** The four lifecycle events of one task, in arrival order. */
export function taskLifecycle(taskId: string): OmicsEvent[] {
  return allTaskEvents().filter((e) => taskIdOf(e) === taskId);
}
