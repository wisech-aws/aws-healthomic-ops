import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearParsers,
  getParser,
  parseDefinition,
  ParseError,
  type WorkflowDefinition,
} from '../../src/parser/types.js';
import { wdlParser, registerWdlParser } from '../../src/parser/wdl.js';

/** A small, realistic WDL workflow with three data-flow-connected calls. */
const SAMPLE_WDL = `
version 1.0

workflow Pipeline {
  input {
    File raw
  }

  # trim raw reads
  call fastqc { input: fastq = raw }

  call align as aligner {
    input:
      reads = fastqc.trimmed  # depends on fastqc
  }

  call summarize {
    input:
      bam = aligner.bam,        # depends on aligner
      report = fastqc.report    # also depends on fastqc
  }
}
`;

function makeDef(
  overrides: { source?: string; workflowId?: string; language?: string } = {},
): WorkflowDefinition {
  const { source = SAMPLE_WDL, workflowId = 'wf-wdl-1', language = 'WDL' } =
    overrides;
  return {
    workflowId,
    language,
    files: { 'main.wdl': source },
    mainPath: 'main.wdl',
  };
}

describe('WDL parser', () => {
  beforeEach(() => {
    // types.ts registry is a module-level singleton; ensure the WDL parser is
    // wired for dispatcher tests regardless of other suites clearing it.
    clearParsers();
    registerWdlParser();
  });

  it('self-registers exactly one parser for WDL', () => {
    expect(getParser('WDL')).toBe(wdlParser);
  });

  it('registerWdlParser is idempotent', () => {
    expect(() => registerWdlParser()).not.toThrow();
    expect(getParser('WDL')).toBe(wdlParser);
  });

  it('creates one node per call statement, using aliases when present', () => {
    const graph = wdlParser.parse(makeDef());
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['aligner', 'fastqc', 'summarize']);
  });

  it('creates producer -> consumer edges from output references', () => {
    const graph = wdlParser.parse(makeDef());
    const edges = graph.edges
      .map((e) => `${e.from}->${e.to}`)
      .sort();
    expect(edges).toEqual([
      'aligner->summarize',
      'fastqc->aligner',
      'fastqc->summarize',
    ]);
  });

  it('ignores references to workflow inputs (non-call names)', () => {
    // `raw` is a workflow input, not a call; it must not become a node or edge.
    const graph = wdlParser.parse(makeDef());
    expect(graph.nodes.some((n) => n.id === 'raw')).toBe(false);
    expect(graph.edges.some((e) => e.from === 'raw' || e.to === 'raw')).toBe(
      false,
    );
  });

  it('de-duplicates repeated references to the same producer', () => {
    const source = `
      workflow W {
        call producer {}
        call consumer {
          input:
            a = producer.x,
            b = producer.y
        }
      }
    `;
    const graph = wdlParser.parse(makeDef({ source }));
    const edges = graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toEqual(['producer->consumer']);
  });

  it('dispatches through parseDefinition and validates the graph', () => {
    const graph = parseDefinition(makeDef());
    expect(graph.workflowId).toBe('wf-wdl-1');
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(3);
  });

  it('rejects a definition with no call statements', () => {
    expect(() => wdlParser.parse(makeDef({ source: 'workflow W {}' }))).toThrow(
      ParseError,
    );
  });

  it('rejects duplicate call invocation names', () => {
    const source = `
      workflow W {
        call foo {}
        call foo {}
      }
    `;
    expect(() => wdlParser.parse(makeDef({ source }))).toThrow(ParseError);
  });

  it('rejects a cyclic definition via the dispatcher', () => {
    const source = `
      workflow W {
        call a { input: x = b.out }
        call b { input: y = a.out }
      }
    `;
    expect(() =>
      parseDefinition(makeDef({ workflowId: 'wf-cycle', source })),
    ).toThrow(ParseError);
  });
});
