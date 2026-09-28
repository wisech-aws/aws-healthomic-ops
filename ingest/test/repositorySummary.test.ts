import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  DynamoRepository,
  buildSummaryItem,
  summarySk,
  groupGsi2Pk,
  groupGsi2Sk,
  encodeGroupSegment,
  runPk,
} from '../src/repository.js';
import { RunStatus } from '../src/domain/status.js';
import { UNVERSIONED_LABEL } from '../src/domain/records.js';
import type { RunSummaryRecord } from '../src/domain/records.js';

function summary(partial: Partial<RunSummaryRecord> = {}): RunSummaryRecord {
  return {
    runId: 'run-1',
    workflowName: 'nf-core-fetchngs',
    workflowVersionName: '1.12.0',
    workflowId: 'wf-1',
    status: RunStatus.COMPLETED,
    stoppedAt: '2026-09-25T13:00:00.000Z',
    updatedAt: '2026-09-25T13:00:01.000Z',
    durationMs: 600_000,
    durationAvailable: true,
    cpuAvailable: false,
    memoryAvailable: false,
    cpuHoursAvailable: false,
    concurrencyAvailable: false,
    taskCount: 3,
    failedTaskCount: 0,
    ...partial,
  };
}

describe('Run_Summary key derivations — example cases', () => {
  it('summary SK is SUMMARY#<runId>, co-located under the run PK', () => {
    expect(summarySk('r-9')).toBe('SUMMARY#r-9');
    expect(runPk('r-9')).toBe('RUN#r-9');
  });

  it('GSI2PK encodes name + version as WF#<name>#<version>', () => {
    expect(groupGsi2Pk('fetchngs', '1.12.0')).toBe('WF#fetchngs#1.12.0');
    // Parentheses are not delimiters, so the Unversioned_Label is left intact.
    expect(groupGsi2Pk('fetchngs', UNVERSIONED_LABEL)).toBe('WF#fetchngs#(unversioned)');
    // A name containing the '#' delimiter is percent-encoded so it can't corrupt the key.
    expect(groupGsi2Pk('a#b', 'v1')).toBe('WF#a%23b#v1');
  });

  it('GSI2SK uses the terminal timestamp, falling back to updatedAt', () => {
    expect(groupGsi2Sk('2026-09-25T13:00:00.000Z', '2026-09-25T13:00:01.000Z')).toBe(
      '2026-09-25T13:00:00.000Z',
    );
    // stoppedAt absent => fall back to updatedAt basis.
    expect(groupGsi2Sk(undefined, '2026-09-25T13:00:01.000Z')).toBe(
      '2026-09-25T13:00:01.000Z',
    );
  });
});

describe('buildSummaryItem — availability honesty', () => {
  it('omits unavailable metric values but always writes their flags', () => {
    const item = buildSummaryItem(summary({ cpuAvailable: false, memoryAvailable: false }));
    expect(item.meanCpu).toBeUndefined();
    expect(item.peakMemoryGiB).toBeUndefined();
    expect(item.cpuAvailable).toBe(false);
    expect(item.memoryAvailable).toBe(false);
    // Available metric is written.
    expect(item.durationMs).toBe(600_000);
    expect(item.durationAvailable).toBe(true);
    expect(item.entityType).toBe('SUMMARY');
  });

  it('carries the hidden workflowId even though grouping uses name+version', () => {
    const item = buildSummaryItem(summary({ workflowId: 'wf-guard' }));
    expect(item.workflowId).toBe('wf-guard');
    expect(item.GSI2PK).toBe('WF#nf-core-fetchngs#1.12.0');
  });
});

// Property 8: group-key segments round-trip for names/versions containing the
// delimiter characters (# and %), so no two distinct groups collide.
// Feature: workflow-performance-reports, Property 8
describe('Run_Summary — Property 8: key encoding safety', () => {
  const decode = (seg: string): string =>
    seg.replace(/%23/g, '#').replace(/%25/g, '%');

  it('distinct (name, version) pairs never produce the same GSI2PK', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (n1, v1, n2, v2) => {
          const k1 = groupGsi2Pk(n1, v1);
          const k2 = groupGsi2Pk(n2, v2);
          const same = n1 === n2 && v1 === v2;
          expect(k1 === k2).toBe(same);
          // Encoding is reversible: decoding each segment recovers the input.
          expect(decode(encodeGroupSegment(n1))).toBe(n1);
          expect(decode(encodeGroupSegment(v1))).toBe(v1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Minimal in-memory doc client mirroring the monotonic condition ──────────
class InMemoryDocClient {
  store = new Map<string, Record<string, unknown>>();
  sends = 0;

  async send(command: { input: Record<string, unknown> }): Promise<unknown> {
    this.sends += 1;
    const input = command.input;
    const item = input.Item as Record<string, unknown>;
    const key = `${String(item.PK)}|${String(item.SK)}`;
    const incoming = (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[
      ':incomingUpdatedAt'
    ] as string | undefined;
    const existing = this.store.get(key);
    const conditionMet =
      existing === undefined ||
      (incoming !== undefined &&
        typeof existing.updatedAt === 'string' &&
        incoming > (existing.updatedAt as string));
    if (!conditionMet) {
      throw new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      });
    }
    this.store.set(key, { ...item });
    return {};
  }

  asDocClient(): DynamoDBDocumentClient {
    return this as unknown as DynamoDBDocumentClient;
  }
}

// Property 7: writing a Run_Summary twice yields one row; the monotonic guard
// keeps the latest updatedAt and never duplicates.
// Feature: workflow-performance-reports, Property 7
describe('DynamoRepository.upsertSummary — Property 7: idempotent monotonic upsert', () => {
  it('re-writing the same summary yields exactly one row, preserving the latest', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 8 }),
        async (updateOffsets) => {
          const db = new InMemoryDocClient();
          const repo = new DynamoRepository(db.asDocClient(), 'test-table');
          const base = Date.parse('2026-09-25T13:00:00.000Z');

          let maxSeen = -1;
          for (const off of updateOffsets) {
            const updatedAt = new Date(base + off * 1000).toISOString();
            const result = await repo.upsertSummary(summary({ updatedAt }));
            maxSeen = Math.max(maxSeen, off);
            expect(['written', 'preserved']).toContain(result.outcome);
          }

          // Exactly one summary row for the run.
          const keys = [...db.store.keys()];
          expect(keys).toEqual(['RUN#run-1|SUMMARY#run-1']);

          // The stored row holds the maximum updatedAt seen.
          const stored = db.store.get('RUN#run-1|SUMMARY#run-1')!;
          const expectedMax = new Date(base + maxSeen * 1000).toISOString();
          expect(stored.updatedAt).toBe(expectedMax);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects a summary with an empty runId before any write', async () => {
    const db = new InMemoryDocClient();
    const repo = new DynamoRepository(db.asDocClient(), 'test-table');
    await expect(repo.upsertSummary(summary({ runId: '' }))).rejects.toThrow();
    expect(db.sends).toBe(0);
  });
});
