/**
 * Shared calendar-window resolution for the Cloudscape `DateRangePicker`.
 *
 * Both the Reports view and the Fleet run list present a `DateRangePicker` and
 * push the selected window into a server query as inclusive ISO-8601 UTC
 * `start`/`end` bounds. This module is the single source of truth for turning a
 * picker value (or `null` => the default last-30-days window) into concrete ISO
 * instants, so the two features cannot drift. It is pure (the clock is injected
 * as `nowMs`) and unit-tested.
 */
import type { DateRangePickerProps } from '@cloudscape-design/components/date-range-picker';

/** Default window when no explicit range is selected: last 30 days (Req 4.2). */
export const DEFAULT_RANGE_DAYS = 30;

/** True when a Cloudscape date value carries no time-of-day (date-only). */
export function isDateOnly(value: string): boolean {
  // Date-only is "YYYY-MM-DD"; anything with a "T" carries a time component.
  return !value.includes('T');
}

/**
 * Floor an absolute-range START to an inclusive ISO instant. A date-only value
 * ("2026-09-28") becomes the start of that day in UTC; a datetime is passed
 * through as its parsed instant. An unparseable value falls back to itself.
 */
export function normalizeRangeStart(value: string): string {
  if (isDateOnly(value)) {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/**
 * Raise an absolute-range END to an INCLUSIVE ISO instant so the whole end date
 * is covered. A date-only value ("2026-09-28") becomes the very end of that day
 * in UTC ("2026-09-28T23:59:59.999Z"), so same-day timestamps (e.g. a run that
 * stopped at 17:29Z today) are included rather than excluded by a naive
 * date-only upper bound. A datetime is passed through as its parsed instant.
 */
export function normalizeRangeEnd(value: string): string {
  if (isDateOnly(value)) {
    const ms = Date.parse(`${value}T23:59:59.999Z`);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** Resolve a Cloudscape date-range value to concrete ISO start/end. */
export function resolveRange(
  value: DateRangePickerProps.Value | null,
  nowMs: number,
): { start: string; end: string } {
  if (value == null) {
    const end = new Date(nowMs);
    const start = new Date(nowMs - DEFAULT_RANGE_DAYS * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (value.type === 'absolute') {
    // Normalize the picker's start/end to INCLUSIVE ISO instants before they
    // become sort-key BETWEEN bounds (the sort key is a full ISO timestamp like
    // "2026-09-28T17:29:09.792Z"). Cloudscape may hand back a date-only string
    // ("2026-09-28") or a datetime; a raw date-only end bound sorts BEFORE any
    // real timestamp on that day, so "today only" would wrongly return nothing.
    // Floor the start to the beginning of its day and raise the end to the very
    // end of its day so the whole selected end date is included.
    return {
      start: normalizeRangeStart(value.startDate),
      end: normalizeRangeEnd(value.endDate),
    };
  }
  // Relative range: compute from unit/amount back from now.
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000, // 30d approximation for the query window
    year: 31_536_000_000,
  };
  const spanMs = (unitMs[value.unit] ?? 86_400_000) * value.amount;
  return {
    start: new Date(nowMs - spanMs).toISOString(),
    end: new Date(nowMs).toISOString(),
  };
}
