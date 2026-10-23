/**
 * In-memory fleet cache (stale-while-revalidate across navigation).
 *
 * Opening a run (or Reports / Compare) unmounts the fleet view, so returning
 * to it used to re-run the whole paged load and reset every control. A cache
 * instance, owned by the dashboard shell, keeps:
 *
 *   - the last fleet UI state (time window, filters, search, grouping, sort,
 *     table page) — one per cache, since the window is part of it; and
 *   - the last loaded runs per time-window SPEC (not per resolved instants:
 *     "last 7 days" is the same logical window at every load).
 *
 * A remount reads both synchronously, shows the cached rows at once, and
 * revalidates in the background. The cache is memory-only (never written to
 * localStorage/sessionStorage), bounded to {@link DEFAULT_MAX_ENTRIES} windows
 * of at most {@link FLEET_LOAD_CAP} runs each, and cleared on sign-out.
 *
 * Deliberately not a module-level singleton: each dashboard owns its own
 * instance (so state can never outlive the signed-in session or leak between
 * tests), and a FleetView without a cache behaves exactly as before.
 */
import type { DateRangePickerProps } from '@cloudscape-design/components/date-range-picker';
import type { Run, RunStatus } from '../api/types';
import type { FleetSortKey, SortDirection } from './runFilters';

/**
 * Maximum number of runs the fleet loads into memory (hybrid paging cap). The
 * list is fetched by following the `nextToken` cursor page-by-page until this
 * cap is reached, then paged/filtered/sorted/grouped client-side. This bounds
 * memory and network for a large fleet (e.g. 50k+ runs) while keeping the rich
 * client-side controls (status/workflow filter, sort, group, search) working
 * over the loaded set. When the cap is hit, the UI surfaces a "showing first N"
 * notice so the list is never silently presented as complete. Also bounds each
 * cache entry.
 */
export const FLEET_LOAD_CAP = 1000;

/** Default number of time windows whose runs are kept (LRU). */
export const DEFAULT_MAX_ENTRIES = 3;

/** Cache key for a time-window spec; see {@link windowKey}. */
export type WindowKey = string;

/** Grouping mode of the fleet table. */
export type FleetGroupMode = 'none' | 'engine' | 'batch';

/** The fleet's restorable UI state. */
export interface FleetUiState {
  readonly range: DateRangePickerProps.Value | null;
  /** Active status filter (empty => all statuses). */
  readonly statuses: readonly RunStatus[];
  readonly workflowId: string | null;
  readonly sortKey: FleetSortKey;
  readonly sortDirection: SortDirection;
  readonly searchQuery: string;
  readonly groupMode: FleetGroupMode;
  readonly currentPage: number;
}

/** The last loaded runs for one time window. */
export interface FleetCacheEntry {
  readonly runs: readonly Run[];
  readonly loadCapped: boolean;
  /** Epoch ms of the last COMPLETED load; null when only partially loaded. */
  readonly lastLoadedAt: number | null;
}

export interface FleetCache {
  getUi(): FleetUiState | null;
  setUi(ui: FleetUiState): void;
  /** Returns the entry for a window (and marks it most recently used). */
  get(key: WindowKey): FleetCacheEntry | undefined;
  /** Stores an entry (truncated to FLEET_LOAD_CAP runs), evicting LRU. */
  set(key: WindowKey, entry: FleetCacheEntry): void;
  /** Drops every entry and the UI state (sign-out). */
  clear(): void;
  /** Number of cached window entries. */
  readonly size: number;
}

/**
 * Stable key for a time-window spec: `default` for the default last-30-days
 * window, `relative:<amount>:<unit>` for a relative range, and
 * `absolute:<start>..<end>` for an absolute range's picker strings.
 */
export function windowKey(range: DateRangePickerProps.Value | null): WindowKey {
  if (range == null) {
    return 'default';
  }
  if (range.type === 'relative') {
    return `relative:${range.amount}:${range.unit}`;
  }
  return `absolute:${range.startDate}..${range.endDate}`;
}

export function createFleetCache(opts?: { maxEntries?: number }): FleetCache {
  const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  // Map iteration order is insertion order; re-inserting on access makes the
  // first key the least recently used.
  const entries = new Map<WindowKey, FleetCacheEntry>();
  let ui: FleetUiState | null = null;

  return {
    getUi: () => ui,
    setUi: (next) => {
      ui = next;
    },
    get: (key) => {
      const entry = entries.get(key);
      if (entry !== undefined) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry;
    },
    set: (key, entry) => {
      entries.delete(key);
      entries.set(
        key,
        entry.runs.length > FLEET_LOAD_CAP
          ? { ...entry, runs: entry.runs.slice(0, FLEET_LOAD_CAP) }
          : entry,
      );
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
    clear: () => {
      entries.clear();
      ui = null;
    },
    get size() {
      return entries.size;
    },
  };
}
