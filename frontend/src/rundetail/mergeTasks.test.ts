import { describe, it, expect } from 'vitest';
import { applyTaskUpdate, mergeTasks, pickTask } from './mergeTasks';
import type { Task } from '../api/types';

const T1 = '2024-01-01T00:01:00.000Z';
const T2 = '2024-01-01T00:02:00.000Z';

function task(partial: Partial<Task> & { taskId: string }): Task {
  return {
    runId: 'run-1',
    name: partial.taskId,
    status: 'RUNNING',
    updatedAt: T1,
    ...partial,
  };
}

describe('mergeTasks', () => {
  it('keeps a COMPLETED@t2 state task over a RUNNING@t1 snapshot', () => {
    const prev = [task({ taskId: 'a', status: 'COMPLETED', updatedAt: T2 })];
    const merged = mergeTasks(prev, [
      task({ taskId: 'a', status: 'RUNNING', updatedAt: T1 }),
    ]);
    expect(merged[0].status).toBe('COMPLETED');
    expect(merged).toBe(prev);
  });

  it('appends a snapshot task unknown to state', () => {
    const prev = [task({ taskId: 'a' })];
    const merged = mergeTasks(prev, [task({ taskId: 'a' }), task({ taskId: 'b' })]);
    expect(merged.map((t) => t.taskId)).toEqual(['a', 'b']);
  });

  it('keeps a state task missing from the snapshot', () => {
    const prev = [task({ taskId: 'a' }), task({ taskId: 'b' })];
    const merged = mergeTasks(prev, [
      task({ taskId: 'b', status: 'COMPLETED', updatedAt: T2 }),
    ]);
    expect(merged.map((t) => [t.taskId, t.status])).toEqual([
      ['a', 'RUNNING'],
      ['b', 'COMPLETED'],
    ]);
  });

  it('takes a newer snapshot record over older state', () => {
    const prev = [task({ taskId: 'a', status: 'STARTING', updatedAt: T1 })];
    const merged = mergeTasks(prev, [
      task({ taskId: 'a', status: 'RUNNING', updatedAt: T2 }),
    ]);
    expect(merged[0].status).toBe('RUNNING');
  });
});

describe('applyTaskUpdate', () => {
  it('ignores a RUNNING@t1 message arriving after COMPLETED@t2', () => {
    const prev = [task({ taskId: 'a', status: 'COMPLETED', updatedAt: T2 })];
    const next = applyTaskUpdate(
      prev,
      task({ taskId: 'a', status: 'RUNNING', updatedAt: T1 }),
    );
    expect(next).toBe(prev);
    expect(next[0].status).toBe('COMPLETED');
  });

  it('appends an unknown task', () => {
    const next = applyTaskUpdate([task({ taskId: 'a' })], task({ taskId: 'b' }));
    expect(next.map((t) => t.taskId)).toEqual(['a', 'b']);
  });
});

describe('pickTask', () => {
  it('breaks an updatedAt tie by status rank', () => {
    const running = task({ taskId: 'a', status: 'RUNNING', updatedAt: T1 });
    const starting = task({ taskId: 'a', status: 'STARTING', updatedAt: T1 });
    expect(pickTask(running, starting)).toBe(running);
    expect(pickTask(starting, running)).toBe(running);
  });

  it('never regresses from terminal, even to a newer non-terminal record', () => {
    const failed = task({ taskId: 'a', status: 'FAILED', updatedAt: T1 });
    const running = task({ taskId: 'a', status: 'RUNNING', updatedAt: T2 });
    expect(pickTask(failed, running)).toBe(failed);
  });

  it('takes the incoming record on a full tie', () => {
    const current = task({ taskId: 'a', status: 'RUNNING', updatedAt: T1 });
    const incoming = task({
      taskId: 'a',
      status: 'RUNNING',
      updatedAt: T1,
      instanceType: 'omics.c.large',
    });
    expect(pickTask(current, incoming)).toBe(incoming);
  });
});
