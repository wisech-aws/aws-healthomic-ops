import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { segmentsFor, segmentsForAll } from './taskSegments';
import { durationMs } from '../fleet/duration';
import { makeTask } from '../taskview/testFactories';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('segmentsFor (Req 8.1–8.4, 12.1, 12.2)', () => {
  it('splits a completed task into queue-wait and run-time', () => {
    const seg = segmentsFor(
      makeTask({
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:05:00.000Z',
        stoppedAt: '2024-01-01T00:20:00.000Z',
      }),
    );
    expect(seg.queueWaitMs).toBe(5 * 60 * 1000);
    expect(seg.runTimeMs).toBe(15 * 60 * 1000);
    expect(seg.running).toBe(false);
    // queueWaitMs derived -> unconfirmed (Req 12.1).
    expect(seg.confidence).toBe('unconfirmed');
  });

  it('measures run-time against now while running and flags it (Req 8.1, 8.4)', () => {
    const start = Date.parse('2024-01-01T00:00:00.000Z');
    const now = start + 30 * 60 * 1000;
    const seg = segmentsFor(
      makeTask({
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:00:00.000Z',
        stoppedAt: null,
      }),
      now,
    );
    expect(seg.runTimeMs).toBe(30 * 60 * 1000);
    expect(seg.running).toBe(true);
  });

  it('reports queueWaitMs unknown with NO now fallback when unstarted (Req 8.2, 8.3)', () => {
    const seg = segmentsFor(
      makeTask({
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: null,
        stoppedAt: null,
      }),
      Date.parse('2024-01-01T05:00:00.000Z'),
    );
    // No startedAt -> both segments unknown; queue-wait must not fall back to now.
    expect(seg.queueWaitMs).toBeNull();
    expect(seg.runTimeMs).toBeNull();
    expect(seg.running).toBe(false);
    // No derived queue-wait -> confirmed (Req 12.2).
    expect(seg.confidence).toBe('confirmed');
  });

  it('reports segments unknown when timestamps are unparseable (Req 8.3)', () => {
    const seg = segmentsFor(
      makeTask({
        createdAt: 'not-a-date',
        startedAt: 'also-bad',
        stoppedAt: 'nope',
      }),
    );
    expect(seg.queueWaitMs).toBeNull();
    expect(seg.runTimeMs).toBeNull();
    expect(seg.confidence).toBe('confirmed');
  });
});

describe('segmentsForAll', () => {
  it('maps each task to its segments preserving order', () => {
    const tasks = [
      makeTask({ taskId: 'a' }),
      makeTask({ taskId: 'b' }),
      makeTask({ taskId: 'c' }),
    ];
    expect(segmentsForAll(tasks).map((s) => s.taskId)).toEqual(['a', 'b', 'c']);
  });
});

/**
 * An arbitrary timestamp field: a parseable ISO string, an unparseable string,
 * `null`, or `undefined` — exercising every present/absent/malformed branch.
 */
const timestampArb = (): fc.Arbitrary<string | null | undefined> =>
  fc.oneof(
    fc.integer({ min: 0, max: 4_000_000_000_000 }).map(iso),
    fc.constant('not-a-timestamp'),
    fc.constant(null),
    fc.constant(undefined),
  );

describe('Property 14: Segments partition a task timeline without fabrication', () => {
  // *For any* Task and *any* now, segmentsFor sets
  //   runTimeMs = durationMs(startedAt, stoppedAt, now),
  //   queueWaitMs = createdAt->startedAt with NO now fallback (null when
  //     startedAt absent/unparseable),
  // each segment null when its bounding timestamps are absent/unparseable,
  // running flag correct, and confidence 'unconfirmed' iff queueWaitMs != null.
  // **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 12.1, 12.2**
  it('holds across arbitrary tasks and now values', () => {
    fc.assert(
      fc.property(
        timestampArb(),
        timestampArb(),
        timestampArb(),
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (createdAt, startedAt, stoppedAt, now) => {
          const task = makeTask({ createdAt, startedAt, stoppedAt });
          const seg = segmentsFor(task, now);

          // Req 8.1: run-time matches durationMs (now fallback while running).
          expect(seg.runTimeMs).toBe(durationMs(startedAt, stoppedAt, now));

          // Req 8.2/8.3: queue-wait from createdAt->startedAt, NO now fallback.
          const created =
            createdAt == null ? Number.NaN : Date.parse(createdAt);
          const started =
            startedAt == null ? Number.NaN : Date.parse(startedAt);
          const expectedQueueWait =
            Number.isNaN(created) || Number.isNaN(started)
              ? null
              : Math.max(0, started - created);
          expect(seg.queueWaitMs).toBe(expectedQueueWait);

          // Req 8.3: a null segment means a bounding timestamp is unknown.
          if (Number.isNaN(started)) {
            expect(seg.runTimeMs).toBeNull();
            expect(seg.queueWaitMs).toBeNull();
          }
          // queue-wait never falls back to now: absent startedAt => null.
          if (startedAt == null) {
            expect(seg.queueWaitMs).toBeNull();
          }

          // Req 8.4: running iff started (parseable) and not stopped.
          const running = !Number.isNaN(started) && stoppedAt == null;
          expect(seg.running).toBe(running);
          if (seg.running) {
            expect(seg.runTimeMs).not.toBeNull();
          }

          // Req 12.1/12.2: confidence unconfirmed iff queue-wait derived.
          expect(seg.confidence).toBe(
            seg.queueWaitMs != null ? 'unconfirmed' : 'confirmed',
          );

          // No fabrication: segments are null or non-negative finite numbers.
          for (const v of [seg.queueWaitMs, seg.runTimeMs]) {
            if (v != null) {
              expect(Number.isFinite(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
    );
  });
});
