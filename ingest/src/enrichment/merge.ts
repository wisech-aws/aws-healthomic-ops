/**
 * Merge helper combining event-derived and enrichment-derived record fields
 * before persistence (Req 2.4).
 *
 * The ingest pipeline produces two partial views of a Run or Task: the
 * event-derived fields extracted by the `EventMapper` (always present, from the
 * EventBridge `detail`) and the enrichment-derived fields fetched from the
 * HealthOmics read APIs (present only when enrichment succeeded). Persistence
 * needs a single record combining both (Req 2.4); when enrichment fails, the
 * enrichment view is empty and the persisted record is derived solely from the
 * event fields, with unretrieved fields left unset (Req 2.5).
 */

/**
 * Merge two partial records into one, preserving fields from both sources.
 *
 * Semantics (Req 2.4, 2.5):
 *   - A field present (defined) in either source appears in the result.
 *   - When a field is present in both, `primary` wins. The event is passed as
 *     `primary` so the value carried on the triggering event — the freshest
 *     signal for that field, e.g. `status` — is never clobbered by an
 *     enrichment read that may lag the event.
 *   - `undefined` values never overwrite a defined value, so an empty
 *     enrichment result (failed enrichment) leaves the event fields intact and
 *     the fields it could not supply simply stay unset (Req 2.5).
 *
 * The result is a shallow merge; both inputs are treated as read-only.
 *
 * @param primary   Fields that take precedence on conflict (event-derived).
 * @param secondary Fields filled in only where `primary` lacks them
 *                  (enrichment-derived).
 */
export function mergeRecords<T extends object>(
  primary: Partial<T>,
  secondary: Partial<T>,
): Partial<T> {
  // Start from the secondary (enrichment) fields, then overlay the primary
  // (event) fields so the event wins on conflict.
  const result: Partial<T> = { ...stripUndefined(secondary) };
  const primaryDefined = stripUndefined(primary);
  for (const key of Object.keys(primaryDefined) as (keyof T)[]) {
    result[key] = primaryDefined[key];
  }
  return result;
}

/**
 * Return a copy of `record` with every `undefined`-valued key removed, so a
 * key explicitly set to `undefined` is treated the same as an absent key and
 * never overwrites a defined value during a merge (Req 2.5).
 */
function stripUndefined<T extends object>(record: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(record) as (keyof T)[]) {
    const value = record[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
