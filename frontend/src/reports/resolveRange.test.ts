import { describe, it, expect } from 'vitest';
import type { DateRangePickerProps } from '@cloudscape-design/components/date-range-picker';

import { resolveRange } from './ReportsView';

// Regression: selecting "today only" as an absolute range returned no runs
// because a date-only end bound ("2026-09-28") sorts BEFORE any real GSI2SK
// timestamp on that day (e.g. "2026-09-28T17:29:09.792Z"). The end bound must
// be raised to the very end of the selected day so same-day runs are included.
describe('resolveRange — absolute date-only range is inclusive of the whole end day', () => {
  const NOW = Date.parse('2026-09-28T17:50:00.000Z');

  it('expands a same-day date-only range to cover the full UTC day', () => {
    const value = {
      type: 'absolute',
      startDate: '2026-09-28',
      endDate: '2026-09-28',
    } as DateRangePickerProps.Value;

    const { start, end } = resolveRange(value, NOW);

    expect(start).toBe('2026-09-28T00:00:00.000Z');
    expect(end).toBe('2026-09-28T23:59:59.999Z');

    // A run that stopped today at 17:29Z must fall within [start, end].
    const stoppedAt = '2026-09-28T17:29:09.792Z';
    expect(stoppedAt >= start && stoppedAt <= end).toBe(true);
  });

  it('floors the start day and raises the end day for a multi-day date-only range', () => {
    const value = {
      type: 'absolute',
      startDate: '2026-09-01',
      endDate: '2026-09-28',
    } as DateRangePickerProps.Value;

    const { start, end } = resolveRange(value, NOW);
    expect(start).toBe('2026-09-01T00:00:00.000Z');
    expect(end).toBe('2026-09-28T23:59:59.999Z');
  });

  it('passes datetime bounds through as their parsed instants', () => {
    const value = {
      type: 'absolute',
      startDate: '2026-09-28T08:00:00.000Z',
      endDate: '2026-09-28T20:00:00.000Z',
    } as DateRangePickerProps.Value;

    const { start, end } = resolveRange(value, NOW);
    expect(start).toBe('2026-09-28T08:00:00.000Z');
    expect(end).toBe('2026-09-28T20:00:00.000Z');
  });

  it('defaults to the last 30 days when no range is selected', () => {
    const { start, end } = resolveRange(null, NOW);
    expect(end).toBe(new Date(NOW).toISOString());
    expect(start).toBe(new Date(NOW - 30 * 86_400_000).toISOString());
  });
});
