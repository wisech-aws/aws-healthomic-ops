import { describe, it, expect } from 'vitest';
import {
  RUN_STATUS_COLORS,
  TASK_STATUS_COLORS,
  runStatusColor,
  taskStatusColor,
  UNKNOWN_STATUS_COLOR,
} from './statusColors';
import type { RunStatus, TaskStatus } from '../api/types';

const RUN_STATUSES: RunStatus[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'DELETED',
  'CANCELLED',
  'FAILED',
];

const TASK_STATUSES: TaskStatus[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
];

describe('status colors', () => {
  it('assigns a color to every RunStatus', () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_STATUS_COLORS[status]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('assigns a color to every TaskStatus', () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUS_COLORS[status]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  // **Validates: Requirements 8.7** — no two RunStatus values share a color.
  it('maps distinct RunStatus values to distinct colors (injective)', () => {
    const colors = RUN_STATUSES.map((s) => RUN_STATUS_COLORS[s]);
    expect(new Set(colors).size).toBe(RUN_STATUSES.length);
  });

  // **Validates: Requirements 9.5** — no two TaskStatus values share a color.
  it('maps distinct TaskStatus values to distinct colors (injective)', () => {
    const colors = TASK_STATUSES.map((s) => TASK_STATUS_COLORS[s]);
    expect(new Set(colors).size).toBe(TASK_STATUSES.length);
  });

  it('falls back to the unknown color for a missing status', () => {
    expect(runStatusColor(null)).toBe(UNKNOWN_STATUS_COLOR);
    expect(runStatusColor(undefined)).toBe(UNKNOWN_STATUS_COLOR);
    expect(taskStatusColor(null)).toBe(UNKNOWN_STATUS_COLOR);
  });

  it('returns the mapped color for a present status', () => {
    expect(runStatusColor('RUNNING')).toBe(RUN_STATUS_COLORS.RUNNING);
    expect(taskStatusColor('COMPLETED')).toBe(TASK_STATUS_COLORS.COMPLETED);
  });
});
