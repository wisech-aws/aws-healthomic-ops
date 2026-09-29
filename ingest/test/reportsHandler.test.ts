import { describe, it, expect, vi } from 'vitest';

// reportsHandler instantiates a DynamoDBClient at module load, which requires a
// region. Set one before the import is evaluated (vi.hoisted runs first).
vi.hoisted(() => {
  process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
  process.env.TABLE_NAME = process.env.TABLE_NAME ?? 'test-table';
});

import { normalizeWindowBound } from '../src/reportsHandler.js';

// Server-side defense-in-depth for the report time-window: the GSI2SK BETWEEN
// bounds must share the canonical millisecond-Z ISO shape of the stored keys,
// or lexicographic comparison silently drops/misincludes runs. A date-only end
// bound in particular sorts before same-day timestamps and would exclude the
// whole final day.
describe('normalizeWindowBound', () => {
  it('floors a date-only start to the beginning of the UTC day', () => {
    expect(normalizeWindowBound('2026-09-28', false)).toBe('2026-09-28T00:00:00.000Z');
  });

  it('raises a date-only end to the very end of the UTC day (inclusive)', () => {
    expect(normalizeWindowBound('2026-09-28', true)).toBe('2026-09-28T23:59:59.999Z');
  });

  it('a same-day run stoppedAt falls within a normalized same-day window', () => {
    const start = normalizeWindowBound('2026-09-28', false);
    const end = normalizeWindowBound('2026-09-28', true);
    const stoppedAt = '2026-09-28T17:29:09.792Z';
    expect(stoppedAt >= start && stoppedAt <= end).toBe(true);
  });

  it('canonicalizes a datetime bound (offset -> Z) to match stored key shape', () => {
    expect(normalizeWindowBound('2026-09-28T12:00:00+00:00', false)).toBe(
      '2026-09-28T12:00:00.000Z',
    );
    expect(normalizeWindowBound('2026-09-28T12:00:00.000Z', true)).toBe(
      '2026-09-28T12:00:00.000Z',
    );
  });

  it('returns an unparseable value unchanged (query then matches nothing, no throw)', () => {
    expect(normalizeWindowBound('not-a-date', false)).toBe('not-a-date');
    expect(normalizeWindowBound('', true)).toBe('');
  });
});
