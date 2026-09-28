import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoRepository, GROUPS_PK, groupRegistrySk } from '../src/repository.js';
import { distinctWorkflowIds } from '../src/metrics/aggregate.js';

/**
 * Minimal in-memory doc client supporting the Group_Registry access pattern:
 * an `UpdateCommand` with `SET ... ADD #runCount :one[, #workflowIds :wid]`
 * (idempotent set-add + counter) and a `QueryCommand` on `PK = GROUPS`.
 */
class RegistryDocClient {
  store = new Map<string, Record<string, unknown>>();

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'UpdateCommand') {
      const key = `${String(input.Key && (input.Key as any).PK)}|${String(
        input.Key && (input.Key as any).SK,
      )}`;
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      const cur =
        this.store.get(key) ??
        ({ PK: (input.Key as any).PK, SK: (input.Key as any).SK, runCount: 0, workflowIds: new Set<string>() } as Record<
          string,
          unknown
        >);
      cur.workflowName = values[':workflowName'];
      cur.versionName = values[':versionName'];
      cur.lastSeen = values[':lastSeen'];
      cur.entityType = 'GROUP';
      cur.runCount = ((cur.runCount as number) ?? 0) + 1;
      if (values[':wid'] instanceof Set) {
        const set = (cur.workflowIds as Set<string>) ?? new Set<string>();
        for (const v of values[':wid'] as Set<string>) set.add(v);
        cur.workflowIds = set;
      }
      this.store.set(key, cur);
      return {};
    }
    if (name === 'QueryCommand') {
      const items = [...this.store.values()]
        .filter((it) => it.PK === GROUPS_PK)
        .map((it) => ({ ...it, workflowIds: [...((it.workflowIds as Set<string>) ?? [])] }));
      return { Items: items, LastEvaluatedKey: undefined };
    }
    throw new Error(`unexpected command ${name}`);
  }

  asDocClient(): DynamoDBDocumentClient {
    return this as unknown as DynamoDBDocumentClient;
  }
}

describe('Group_Registry — keys + idempotent set-add', () => {
  it('registry SK matches the GSI2 group encoding', () => {
    expect(groupRegistrySk('nf-core-fetchngs', '(unversioned)')).toBe(
      'WF#nf-core-fetchngs#(unversioned)',
    );
    expect(groupRegistrySk('a#b', 'v1')).toBe('WF#a%23b#v1');
  });

  it('adding the same workflowId twice does not duplicate it', async () => {
    const db = new RegistryDocClient();
    const repo = new DynamoRepository(db.asDocClient(), 't');
    await repo.upsertGroupRegistry('wf', 'v1', 'id-1');
    await repo.upsertGroupRegistry('wf', 'v1', 'id-1');
    await repo.upsertGroupRegistry('wf', 'v1', 'id-2');
    const groups = await repo.listGroupRegistry();
    expect(groups).toHaveLength(1);
    expect([...groups[0].workflowIds].sort()).toEqual(['id-1', 'id-2']);
    expect(groups[0].runCount).toBe(3);
  });
});

// Property 14: the set of groups (and their distinct workflowIds) enumerated
// from the registry equals what is derivable from all the individual runs.
// Feature: workflow-performance-reports, Property 14
describe('Group_Registry — Property 14: registry equivalence', () => {
  it('registry groups+ids equal the direct grouping of the run stream', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.constantFrom('alpha', 'beta', 'gamma'),
            version: fc.constantFrom('(unversioned)', 'v1', 'v2'),
            id: fc.constantFrom('w1', 'w2', 'w3'),
          }),
          { maxLength: 40 },
        ),
        async (runs) => {
          const db = new RegistryDocClient();
          const repo = new DynamoRepository(db.asDocClient(), 't');

          // Reference grouping computed directly from the run stream.
          const ref = new Map<string, Set<string>>();
          for (const r of runs) {
            const k = `${r.name}\u0000${r.version}`;
            const s = ref.get(k) ?? new Set<string>();
            s.add(r.id);
            ref.set(k, s);
            await repo.upsertGroupRegistry(r.name, r.version, r.id);
          }

          const registry = await repo.listGroupRegistry();
          // Same set of group keys.
          const regKeys = new Set(registry.map((g) => `${g.workflowName}\u0000${g.versionName}`));
          expect(regKeys).toEqual(new Set(ref.keys()));
          // Same distinct workflowIds per group.
          for (const g of registry) {
            const k = `${g.workflowName}\u0000${g.versionName}`;
            expect(new Set(distinctWorkflowIds(g.workflowIds))).toEqual(ref.get(k));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
