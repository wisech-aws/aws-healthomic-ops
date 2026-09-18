import { describe, it, expect } from 'vitest';
import { extractErrorExcerpt } from '../src/errorExcerpt.js';

describe('extractErrorExcerpt', () => {
  it('returns not-found for an empty log', () => {
    expect(extractErrorExcerpt([])).toEqual({ found: false, lines: [], truncated: false });
  });

  it('returns not-found for a healthy log with no error-shaped lines', () => {
    const result = extractErrorExcerpt(['Task started', 'doing work', 'Task completed']);
    expect(result).toEqual({ found: false, lines: [], truncated: false });
  });

  it('returns not-found for whitespace-only lines', () => {
    expect(extractErrorExcerpt(['   ', '', '\t']).found).toBe(false);
  });

  // Real production case 1: a task-level failure with plain [ERROR] lines and
  // no stack trace at all (verified against fetchngs run 2451678, task
  // 8447635 — NFCORE_FETCHNGS:SRA:SRA_IDS_TO_RUNINFO timing out reaching NCBI).
  it('extracts a plain [ERROR]-marked block with no stack trace', () => {
    const lines = [
      'Task started',
      '[ERROR] We failed to reach a server.',
      '[ERROR] Reason: [Errno 110] Connection timed out',
      'Task failed',
    ];
    const result = extractErrorExcerpt(lines);
    expect(result.found).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.lines).toEqual([
      '[ERROR] We failed to reach a server.',
      '[ERROR] Reason: [Errno 110] Connection timed out',
      'Task failed',
    ]);
  });

  // Real production case 2: an engine-level Nextflow SchemaValidationException
  // followed by ~12 lines of "-> Entry N: Error for field..." detail lines and
  // then a long trailing Java/Groovy stack trace (verified against rnaseq run
  // 3449309's engine log stream — the actual `SchemaValidationException`
  // headline sits many detail-prose lines before the line that superficially
  // looks most "error-shaped", which is why the naive last-error-line
  // heuristic is wrong and the headline-then-forward strategy is needed).
  it('extracts the exception headline through its detail lines, excluding the trailing stack trace', () => {
    const lines = [
      'Sep-14 22:15:16.547 [main] ERROR n.v.samplesheet.SamplesheetConverter - Validation of samplesheet failed!',
      "nextflow.validation.exceptions.SchemaValidationException: The following errors have been detected in samplesheet_test.csv:",
      "-> Entry 1: Error for field 'fastq_2' (https://example.com/a_2.fastq.gz): the file or directory does not exist",
      "-> Entry 1: Error for field 'fastq_1' (https://example.com/a_1.fastq.gz): the file or directory does not exist",
      'at org.codehaus.groovy.vmplugin.v8.IndyInterface.fromCache(IndyInterface.java:321)',
      'at nextflow.validation.samplesheet.SamplesheetConverter.validateAndConvertToList(SamplesheetConverter.groovy:107)',
      'at nextflow.script.WorkflowDef.run0(WorkflowDef.groovy:205)',
      'at nextflow.cli.Launcher.main(Launcher.groovy:675)',
    ];
    const result = extractErrorExcerpt(lines);
    expect(result.found).toBe(true);
    expect(result.truncated).toBe(false);
    // Starts at the exception headline, NOT the superficially-error-shaped
    // "-> Entry 1: Error for field..." lines, and excludes every stack frame.
    expect(result.lines).toEqual([
      "nextflow.validation.exceptions.SchemaValidationException: The following errors have been detected in samplesheet_test.csv:",
      "-> Entry 1: Error for field 'fastq_2' (https://example.com/a_2.fastq.gz): the file or directory does not exist",
      "-> Entry 1: Error for field 'fastq_1' (https://example.com/a_1.fastq.gz): the file or directory does not exist",
    ]);
  });

  it('truncates a headline block longer than maxLines, keeping the earliest (most informative) lines', () => {
    const headline = 'com.example.BigException: too many details';
    const details = Array.from({ length: 20 }, (_, i) => `-> Entry ${i}: detail line`);
    const stack = ['at com.example.Foo.bar(Foo.java:1)', 'at com.example.Foo.baz(Foo.java:2)'];
    const lines = [headline, ...details, ...stack];
    const result = extractErrorExcerpt(lines, 5);
    expect(result.found).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(5);
    expect(result.lines[0]).toBe(headline);
  });

  it('truncates a no-stack-trace fallback block longer than maxLines, keeping the latest lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `[ERROR] detail ${i}`);
    const result = extractErrorExcerpt(lines, 5);
    expect(result.found).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(5);
    // Kept the LAST 5, i.e. details 15..19.
    expect(result.lines[0]).toBe('[ERROR] detail 15');
    expect(result.lines[4]).toBe('[ERROR] detail 19');
  });

  it('does not anchor on prose containing the word "error" as the headline (regression)', () => {
    // A line like "Error for field 'x'" must NOT be mistaken for the true
    // exception headline when a real headline exists earlier in the block.
    const lines = [
      'my.pkg.RealException: the actual cause',
      "Error for field 'x': looks error-shaped but is just a detail line",
      'at my.pkg.Foo.bar(Foo.java:1)',
    ];
    const result = extractErrorExcerpt(lines);
    expect(result.lines[0]).toBe('my.pkg.RealException: the actual cause');
  });

  it('falls back to the generic pattern when a stack trace exists but no headline precedes it', () => {
    // Trailing stack frames with no true headline line above them at all.
    const lines = [
      'something failed unexpectedly',
      'at my.pkg.Foo.bar(Foo.java:1)',
      'at my.pkg.Foo.baz(Foo.java:2)',
    ];
    const result = extractErrorExcerpt(lines);
    expect(result.found).toBe(true);
    expect(result.lines).toEqual(['something failed unexpectedly']);
  });

  it('ignores blank lines interleaved with real content', () => {
    const lines = ['', '[ERROR] boom', '', 'Task failed', ''];
    const result = extractErrorExcerpt(lines);
    expect(result.lines).toEqual(['[ERROR] boom', 'Task failed']);
  });

  it('is pure: calling twice with the same input yields the same result', () => {
    const lines = ['[ERROR] boom', 'Task failed'];
    expect(extractErrorExcerpt(lines)).toEqual(extractErrorExcerpt(lines));
  });
});
