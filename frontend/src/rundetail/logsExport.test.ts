import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatTs, logFilename, logContent } from './logsExport';

describe('logFilename', () => {
  it('uses taskId as the suffix when present', () => {
    expect(logFilename({ runId: 'r1', taskId: 't1', stream: 'TASK' })).toBe(
      'r1-t1.log',
    );
  });

  it('falls back to the stream name when there is no taskId', () => {
    expect(logFilename({ runId: 'r1', stream: 'ENGINE' })).toBe('r1-ENGINE.log');
  });

  it('sanitizes unsafe characters to underscores', () => {
    expect(logFilename({ runId: 'run/with spaces', stream: 'a:b' })).toBe(
      'run_with_spaces-a_b.log',
    );
  });
});

describe('logContent', () => {
  it('reproduces exactly the loaded lines in order with the timestamp prefix', () => {
    const events = [
      { timestamp: 1704067200000, message: 'staging genome.fasta' },
      { timestamp: 1704067201000, message: 'submitted process FASTQC' },
    ];
    expect(logContent(events)).toBe(
      [
        `${formatTs(1704067200000)}  staging genome.fasta`,
        `${formatTs(1704067201000)}  submitted process FASTQC`,
      ].join('\n'),
    );
  });

  it('returns an empty string for an empty array', () => {
    expect(logContent([])).toBe('');
  });

  // Property: the serialized line count equals the input length and every
  // emitted line is derived from an input event (no fabricated lines).
  it('property: one derived line per input event, nothing fabricated', () => {
    const eventArb = fc.record({
      timestamp: fc.integer({ min: 0, max: 4_102_444_800_000 }),
      message: fc.string({ maxLength: 40 }),
    });
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        const out = logContent(events);
        if (events.length === 0) {
          expect(out).toBe('');
          return;
        }
        const lines = out.split('\n');
        expect(lines).toHaveLength(events.length);
        lines.forEach((line, i) => {
          expect(line).toBe(`${formatTs(events[i].timestamp)}  ${events[i].message}`);
        });
      }),
      { numRuns: 200 },
    );
  });

  // Property: the filename only contains characters from the sanitized class
  // (the stream placeholder is never emitted raw with unsafe characters).
  it('property: logFilename output only contains the sanitized character class', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (runId, stream) => {
          const name = logFilename({ runId, stream });
          expect(name).toMatch(/^[a-z0-9._-]*$/i);
        },
      ),
      { numRuns: 200 },
    );
  });
});
