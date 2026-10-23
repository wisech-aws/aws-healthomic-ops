import { describe, it, expect } from 'vitest';
import {
  createFleetCache,
  windowKey,
  FLEET_LOAD_CAP,
  type FleetCacheEntry,
  type FleetUiState,
} from './fleetCache';
import type { Run } from '../api/types';

function entry(count: number, prefix = 'r'): FleetCacheEntry {
  const runs: Run[] = Array.from({ length: count }, (_, i) => ({
    runId: `${prefix}-${i}`,
    updatedAt: '2024-01-01T00:00:00.000Z',
  }));
  return { runs, loadCapped: false, lastLoadedAt: 1 };
}

const UI: FleetUiState = {
  range: { type: 'relative', amount: 7, unit: 'day', key: 'prev-7' },
  statuses: ['FAILED'],
  workflowId: 'wf-1',
  sortKey: 'duration',
  sortDirection: 'asc',
  searchQuery: 'abc',
  groupMode: 'batch',
  currentPage: 2,
};

describe('windowKey', () => {
  it('keys the default, relative and absolute window specs', () => {
    expect(windowKey(null)).toBe('default');
    expect(
      windowKey({ type: 'relative', amount: 7, unit: 'day', key: 'prev-7' }),
    ).toBe('relative:7:day');
    expect(
      windowKey({
        type: 'absolute',
        startDate: '2024-06-01',
        endDate: '2024-06-10',
      }),
    ).toBe('absolute:2024-06-01..2024-06-10');
  });

  it('keys a relative window by amount/unit, not by preset key', () => {
    expect(windowKey({ type: 'relative', amount: 7, unit: 'day' })).toBe(
      windowKey({ type: 'relative', amount: 7, unit: 'day', key: 'prev-7' }),
    );
  });
});

describe('createFleetCache', () => {
  it('round-trips entries and UI state', () => {
    const cache = createFleetCache();
    expect(cache.get('default')).toBeUndefined();
    expect(cache.getUi()).toBeNull();
    const e = entry(2);
    cache.set('default', e);
    cache.setUi(UI);
    expect(cache.get('default')).toBe(e);
    expect(cache.getUi()).toBe(UI);
    expect(cache.size).toBe(1);
  });

  it('evicts the least recently used window beyond maxEntries; get refreshes recency', () => {
    const cache = createFleetCache({ maxEntries: 3 });
    cache.set('a', entry(1, 'a'));
    cache.set('b', entry(1, 'b'));
    cache.set('c', entry(1, 'c'));
    // Touch 'a' so 'b' becomes the least recently used.
    cache.get('a');
    cache.set('d', entry(1, 'd'));
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('caps an entry at FLEET_LOAD_CAP runs', () => {
    const cache = createFleetCache();
    cache.set('default', entry(FLEET_LOAD_CAP + 1));
    expect(cache.get('default')!.runs).toHaveLength(FLEET_LOAD_CAP);
  });

  it('clear() drops every entry and the UI state', () => {
    const cache = createFleetCache();
    cache.set('a', entry(1));
    cache.set('b', entry(1));
    cache.setUi(UI);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.getUi()).toBeNull();
    expect(cache.get('a')).toBeUndefined();
  });
});
