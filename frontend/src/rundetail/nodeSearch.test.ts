import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Node } from 'reactflow';
import { matchNodeIds, normalizeQuery } from './nodeSearch';
import type { TaskNodeData } from './graphLayout';

function node(id: string, label: string): Node<TaskNodeData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      label,
      status: null,
      color: '#000',
      matched: true,
      highlighted: false,
    },
  };
}

describe('normalizeQuery', () => {
  it('trims and lower-cases', () => {
    expect(normalizeQuery('  Align  ')).toBe('align');
  });
  it('collapses whitespace-only queries to empty', () => {
    expect(normalizeQuery('   ')).toBe('');
    expect(normalizeQuery('')).toBe('');
  });
});

describe('matchNodeIds', () => {
  const nodes = [
    node('a', 'align_reads'),
    node('b', 'call_variants'),
    node('c', 'ALIGN_bam'),
    node('d', 'index'),
  ];

  it('returns an empty set for an empty/whitespace query (no active search)', () => {
    expect(matchNodeIds(nodes, '').size).toBe(0);
    expect(matchNodeIds(nodes, '   ').size).toBe(0);
  });

  it('matches case-insensitively on a substring of the label', () => {
    const ids = matchNodeIds(nodes, 'align');
    expect([...ids].sort()).toEqual(['a', 'c']);
  });

  it('matches the exact and partial substrings', () => {
    expect([...matchNodeIds(nodes, 'variants')]).toEqual(['b']);
    expect([...matchNodeIds(nodes, 'IN')].sort()).toEqual(['d']);
  });

  it('returns no matches when nothing contains the query', () => {
    expect(matchNodeIds(nodes, 'zzz').size).toBe(0);
  });

  // Property: every matched node's label contains the (normalized) query, and
  // every non-matched node's label does not — a sound, complete substring test.
  it('property: matches are exactly the labels containing the query', () => {
    const labelArb = fc.string({ minLength: 0, maxLength: 12 });
    fc.assert(
      fc.property(
        fc.array(labelArb, { maxLength: 20 }),
        fc.string({ maxLength: 6 }),
        (labels, query) => {
          const ns = labels.map((l, i) => node(`n${i}`, l));
          const matched = matchNodeIds(ns, query);
          const q = normalizeQuery(query);
          for (const n of ns) {
            const contains = q !== '' && n.data.label.toLowerCase().includes(q);
            expect(matched.has(n.id)).toBe(contains);
          }
          // Empty query => never matches anything.
          if (q === '') {
            expect(matched.size).toBe(0);
          }
        },
      ),
    );
  });
});
