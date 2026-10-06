/**
 * Relative-timestamp formatting helpers (QoL #5).
 *
 * Renders an ISO-8601 instant as a short, human-friendly relative string
 * ("just now", "5m ago", "3h ago", "2 days ago") while keeping the exact
 * absolute timestamp available separately (see {@link formatAbsoluteTime}) so
 * the precise value is never lost — only summarized.
 *
 * Pure, now-injectable helpers mirroring the conventions in `duration.ts`:
 *  - a `now: number = Date.now()` parameter so time logic is deterministic and
 *    testable (see `src/fleet/duration.ts`, `src/fleet/staleness.ts`), and
 *  - the dash sentinel '—' for an absent or unparseable value, NEVER a guessed
 *    relative value (strict no-fabrication rule).
 */

/** The explicit "unknown" affordance used throughout the app for absent data. */
const DASH = '—';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Formats an ISO-8601 timestamp as a short relative string, measured against
 * `now`.
 *
 * Buckets (by elapsed = now − parsed):
 *  - elapsed < 60s (including any future/≤0 elapsed, to avoid fabricating a
 *    "future" or negative relative value) -> `'just now'`
 *  - < 1h -> `'<n>m ago'`
 *  - < 1 day -> `'<n>h ago'`
 *  - otherwise -> `'<n> day ago'` (singular at exactly 1) / `'<n> days ago'`
 *
 * Returns the dash sentinel '—' for null/undefined/empty/unparseable input
 * (`Number.isNaN(Date.parse(...))`) — never a guessed relative value.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (iso == null || iso === '') {
    return DASH;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return DASH;
  }
  const elapsed = now - ms;
  // Future or sub-minute elapsed collapses to "just now": we never render a
  // negative/"in the future" relative value (no-fabrication).
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `${minutes}m ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `${hours}h ago`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * Formats an ISO-8601 timestamp as its exact absolute locale string
 * (matching `formatStartTime` in `duration.ts`), or `null` when the value is
 * absent or unparseable.
 *
 * Returning `null` (rather than a dash) lets a caller distinguish "there is an
 * absolute value to show on hover" from "there is nothing to show" without
 * conflating it with the relative dash sentinel.
 */
export function formatAbsoluteTime(
  iso: string | null | undefined,
): string | null {
  if (iso == null || iso === '') {
    return null;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toLocaleString();
}
