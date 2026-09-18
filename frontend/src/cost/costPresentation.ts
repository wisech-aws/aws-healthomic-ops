/**
 * Cost-presentation derivation for `RunDetailView`/`RunCostPanel`
 * (Req 5.6, 5.7, 6.2–6.5; design §9(a), Property 11).
 *
 * `getRunCostEstimate` can come back loading, as a typed error, as a success
 * with no computable (priced) line item, or as a success carrying at least one
 * computable line item. This module is the pure derivation of which of those
 * four states `RunCostPanel` should render.
 *
 * The load-bearing theme is honesty about availability (Req 6): a query in
 * progress, a typed failure, and "nothing could be priced" are three distinct
 * states, never conflated, and an unavailable estimate is never rendered as a
 * fabricated or zero cost. A line item is "computable" exactly when its
 * `available` flag is true; unavailable line items carry `null` numeric fields
 * and coexist with the computable ones (Req 6.1, 6.2), so they are surfaced in
 * the `ready` state rather than suppressed.
 */
import type { CostLineItem, RunCostEstimate } from '../api/types';

/** The four distinct, mutually-exclusive states the cost panel can be in. */
export type CostPhase = 'loading' | 'error' | 'unavailable' | 'ready';

/**
 * What `RunCostPanel` should render for the estimated-cost view — a
 * discriminated union over the four honest phases (Property 11).
 */
export type CostPresentation =
  /** The cost query is in progress (Req 5.6), distinct from `unavailable`. */
  | { readonly kind: 'loading' }
  /**
   * The cost query failed with a typed error (Req 5.7), distinct from
   * `unavailable`. Carries the error message for the retryable error state.
   */
  | { readonly kind: 'error'; readonly message: string }
  /**
   * No line item could be priced for the run (Req 6.4, 6.5), distinct from
   * loading and error — an explicit unavailable state, never a fabricated 0.
   */
  | { readonly kind: 'unavailable' }
  /**
   * At least one line item is computable (Req 5.2). Carries the full breakdown
   * (computable *and* unavailable line items coexist per Req 6.2), the running
   * total / currency / effective date, and whether the total is `partial` —
   * true when at least one line item is unavailable (Req 6.3).
   */
  | {
      readonly kind: 'ready';
      readonly lineItems: CostLineItem[];
      readonly total?: number | null;
      readonly currency?: string | null;
      readonly effectiveDate?: string | null;
      /** True => the displayed total is partial (Req 6.3). */
      readonly partial: boolean;
    };

/**
 * Derive the estimated-cost presentation state from a `getRunCostEstimate`
 * result (Req 5.6, 5.7, 6.2–6.5; Property 11).
 *
 * Priority order (exactly one phase is returned):
 *  1. `isLoading` true → `loading`, regardless of `result` (Req 5.6).
 *  2. Otherwise a non-null `result.error` → `error`, carrying that message —
 *     never conflated with `unavailable` (Req 5.7).
 *  3. Otherwise a result with no computable (`available === true`) line item →
 *     `unavailable`, never `error`/`ready` (Req 6.4, 6.5).
 *  4. Otherwise → `ready`, carrying every line item (computable and
 *     unavailable coexist, Req 6.2), the total/currency/effectiveDate, and the
 *     `partial` flag straight from the result (Req 6.3).
 *
 * Pure, total, and deterministic: no I/O, no mutation, no time or randomness.
 */
export function deriveCostPresentation(
  result: RunCostEstimate | null,
  isLoading: boolean,
): CostPresentation {
  if (isLoading) {
    return { kind: 'loading' };
  }

  if (result == null) {
    return { kind: 'unavailable' };
  }

  if (result.error != null) {
    return { kind: 'error', message: result.error };
  }

  const hasComputableLineItem = result.lineItems.some(
    (lineItem) => lineItem.available === true,
  );
  if (!hasComputableLineItem) {
    return { kind: 'unavailable' };
  }

  return {
    kind: 'ready',
    lineItems: result.lineItems,
    total: result.total,
    currency: result.currency,
    effectiveDate: result.effectiveDate,
    partial: result.partial,
  };
}
