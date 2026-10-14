/**
 * DAG node search (case-insensitive substring match on the node label).
 *
 * Pure helper so the match logic is unit- and property-testable without
 * rendering React Flow. The run detail view uses the returned id set to
 * emphasize matching nodes and dim the rest, and to fit the view to the matches.
 *
 * An empty or whitespace-only query means "no active search": the helper
 * returns an empty set and callers render the graph normally (nothing dimmed).
 * No fabrication — only nodes whose label actually contains the query match.
 */
import type { Node } from 'reactflow';

/** Normalize a query: trimmed and lower-cased, or '' when effectively empty. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * The set of node ids whose label contains `query` (case-insensitive).
 *
 * Returns an empty set for an empty/whitespace-only query (no active search).
 * Matching is a plain substring test on the node's `data.label`.
 */
export function matchNodeIds(
  // Accepts any node, regardless of its data shape. Task nodes carry a `label`
  // (and match on it); the Inferred_DAG continuation-cue node deliberately
  // carries NO `label`, so it can never match a query. Reading the label
  // defensively (it may be absent) keeps this safe for both.
  nodes: readonly Node[],
  query: string,
): Set<string> {
  const q = normalizeQuery(query);
  const matches = new Set<string>();
  if (q === '') {
    return matches;
  }
  for (const node of nodes) {
    const raw = (node.data as { label?: unknown } | undefined)?.label;
    const label = typeof raw === 'string' ? raw : '';
    if (label.toLowerCase().includes(q)) {
      matches.add(node.id);
    }
  }
  return matches;
}
