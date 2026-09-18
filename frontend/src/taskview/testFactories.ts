/**
 * Test-only factories for building {@link Task} values with sensible defaults.
 * Kept in `src` (not a `.test.ts` file) so multiple test modules can import it.
 * Not referenced by production code.
 */

import type { Task, TaskStatus } from '../api/types';

let counter = 0;

/** Build a {@link Task} with overridable fields and a unique default id. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    runId: 'run-1',
    taskId: `task-${counter}`,
    status: 'COMPLETED',
    name: `task-${counter}`,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: '2024-01-01T00:00:00.000Z',
    stoppedAt: '2024-01-01T00:10:00.000Z',
    updatedAt: '2024-01-01T00:10:00.000Z',
    cpus: 1,
    memory: 1,
    ...overrides,
  };
}

/** The full set of task statuses (mirrors `TaskStatus`). */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
];
