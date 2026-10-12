import { describe, it, expect } from 'vitest';
import {
  resolveRange,
  normalizeRangeStart,
  normalizeRangeEnd,
  isDateOnly,
  DEFAULT_RANGE_DAYS,
} from './dateRange';

const NOW = Date.parse('2024-06-15T12:00:00.000Z');

describe('resolveRange', () => {
  it('null value defaults to the last-30-days window [now-30d, now]', () => {
    const { start, end } = resolveRange(null, NOW);
    expect(end).toBe(new Date(NOW).toISOString());
    expect(start).toBe(
      new Date(NOW - DEFAULT_RANGE_DAYS * 86_400_000).toISOString(),
    );
  });

  it('absolute date-only range is normalized to inclusive day bounds', () => {
    const { start, end } = resolveRange(
      { type: 'absolute', startDate: '2024-06-01', endDate: '2024-06-10' },
      NOW,
    );
    expect(start).toBe('2024-06-01T00:00:00.000Z');
    expect(end).toBe('2024-06-10T23:59:59.999Z');
  });

  it('absolute datetime range is passed through as parsed instants', () => {
    const { start, end } = resolveRange(
      {
        type: 'absolute',
        startDate: '2024-06-01T08:30:00.000Z',
        endDate: '2024-06-10T17:45:00.000Z',
      },
      NOW,
    );
    expect(start).toBe('2024-06-01T08:30:00.000Z');
    expect(end).toBe('2024-06-10T17:45:00.000Z');
  });

  it('relative range is computed back from now (7 days)', () => {
    const { start, end } = resolveRange(
      { type: 'relative', amount: 7, unit: 'day', key: 'prev-7' },
      NOW,
    );
    expect(end).toBe(new Date(NOW).toISOString());
    expect(start).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
  });

  it('relative range for 90 days computes the right span', () => {
    const { start } = resolveRange(
      { type: 'relative', amount: 90, unit: 'day', key: 'prev-90' },
      NOW,
    );
    expect(start).toBe(new Date(NOW - 90 * 86_400_000).toISOString());
  });
});

describe('isDateOnly / normalize helpers', () => {
  it('isDateOnly distinguishes date-only from datetime', () => {
    expect(isDateOnly('2024-06-01')).toBe(true);
    expect(isDateOnly('2024-06-01T00:00:00.000Z')).toBe(false);
  });

  it('normalizeRangeStart floors a date-only to 00:00:00.000Z', () => {
    expect(normalizeRangeStart('2024-06-01')).toBe('2024-06-01T00:00:00.000Z');
  });

  it('normalizeRangeEnd raises a date-only to 23:59:59.999Z', () => {
    expect(normalizeRangeEnd('2024-06-01')).toBe('2024-06-01T23:59:59.999Z');
  });
});
