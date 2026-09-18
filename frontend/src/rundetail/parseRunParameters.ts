/**
 * Parse a run's `parameters` into a plain object, tolerant of how AppSync's
 * `AWSJSON` scalar may deliver it.
 *
 * The ingest pipeline stores `parameters` as a JSON string in DynamoDB; over
 * the wire an `AWSJSON` field can arrive as (a) an already-parsed object, (b) a
 * single JSON-encoded string, or (c) a double-encoded string (a JSON string
 * whose decoded value is itself a JSON string). An earlier version only handled
 * case (b), so double-encoded payloads decoded to a string, failed the
 * `typeof === 'object'` check, and rendered nothing in the run detail view.
 * This unwraps up to two levels of string encoding and returns null for
 * anything that is not a (possibly empty) object.
 */
export function parseRunParameters(
  parameters: unknown,
): Record<string, unknown> | null {
  if (parameters == null || parameters === '') {
    return null;
  }
  // Already an object (AppSync decoded the AWSJSON for us).
  if (typeof parameters === 'object') {
    return parameters as Record<string, unknown>;
  }
  if (typeof parameters !== 'string') {
    return null;
  }
  let value: unknown = parameters;
  // Unwrap up to two levels of JSON-string encoding.
  for (let i = 0; i < 2 && typeof value === 'string'; i += 1) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}
