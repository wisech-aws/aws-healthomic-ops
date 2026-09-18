import { describe, it, expect, beforeEach } from 'vitest';
import {
  ParseError,
  hasCycle,
  assertValidGraph,
  registerParser,
  getParser,
  clearParsers,
  parseDefinition,
  isSupportedLanguage,
  SUPPORTED_LANGUAGES,
  type DefinitionParser,
  type StaticGraph,
  type WorkflowDefinition,
} from '../../src/parser/types.js';

function makeGraph(overrides: Partial<StaticGraph> = {}): StaticGraph {
  return {
    workflowId: 'wf-1',
    nodes: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    edges: [{ from: 'a', to: 'b' }],
    fidelity: 'exact',
    ...overrides,
  };
}

function makeDef(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflowId: 'wf-1',
    language: 'WDL',
    files: { 'main.wdl': 'workflow {}' },
    mainPath: 'main.wdl',
    ...overrides,
  };
}

/** A trivial parser that returns a fixed graph, for dispatcher tests. */
function makeStubParser(
  language: DefinitionParser['language'],
  graph: StaticGraph,
  canParse = true,
): DefinitionParser {
  return {
    language,
    canParse: () => canParse,
    parse: () => graph,
  };
}

describe('isSupportedLanguage', () => {
  it('accepts each supported language', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(isSupportedLanguage(language)).toBe(true);
    }
  });

  it('rejects unsupported or non-string values', () => {
    expect(isSupportedLanguage('SMK')).toBe(false);
    expect(isSupportedLanguage('wdl')).toBe(false);
    expect(isSupportedLanguage(undefined)).toBe(false);
    expect(isSupportedLanguage(42)).toBe(false);
  });
});

describe('ParseError', () => {
  it('carries workflowId and reason and is an Error', () => {
    const err = new ParseError('wf-9', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ParseError);
    expect(err.workflowId).toBe('wf-9');
    expect(err.reason).toBe('boom');
    expect(err.message).toContain('wf-9');
    expect(err.message).toContain('boom');
  });
});

describe('hasCycle', () => {
  it('returns false for an acyclic graph', () => {
    const nodes = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'a', to: 'c' },
    ];
    expect(hasCycle(nodes, edges)).toBe(false);
  });

  it('detects a simple cycle', () => {
    const nodes = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect(hasCycle(nodes, edges)).toBe(true);
  });

  it('detects a self-loop as a cycle', () => {
    const nodes = [{ id: 'a', name: 'A' }];
    const edges = [{ from: 'a', to: 'a' }];
    expect(hasCycle(nodes, edges)).toBe(true);
  });

  it('does not overflow on a large linear chain', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => ({
      id: `n${i}`,
      name: `N${i}`,
    }));
    const edges = Array.from({ length: 4999 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
    }));
    expect(hasCycle(nodes, edges)).toBe(false);
  });
});

describe('assertValidGraph', () => {
  it('returns a valid acyclic graph unchanged', () => {
    const graph = makeGraph();
    expect(assertValidGraph(graph)).toBe(graph);
  });

  it('rejects duplicate node ids', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'a', name: 'A' },
        { id: 'a', name: 'A2' },
      ],
      edges: [],
    });
    expect(() => assertValidGraph(graph)).toThrow(ParseError);
  });

  it('rejects empty node ids', () => {
    const graph = makeGraph({ nodes: [{ id: '', name: 'A' }], edges: [] });
    expect(() => assertValidGraph(graph)).toThrow(ParseError);
  });

  it('rejects edges referencing unknown nodes', () => {
    const graph = makeGraph({ edges: [{ from: 'a', to: 'zzz' }] });
    expect(() => assertValidGraph(graph)).toThrow(ParseError);
  });

  it('rejects cyclic graphs and identifies the workflowId', () => {
    const graph = makeGraph({
      workflowId: 'wf-cycle',
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    try {
      assertValidGraph(graph);
      throw new Error('expected ParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).workflowId).toBe('wf-cycle');
      expect((err as ParseError).reason).toContain('cycle');
    }
  });
});

describe('parser registry', () => {
  beforeEach(() => {
    clearParsers();
  });

  it('registers and retrieves exactly one parser per language', () => {
    const parser = makeStubParser('WDL', makeGraph());
    registerParser(parser);
    expect(getParser('WDL')).toBe(parser);
  });

  it('rejects a second registration for the same language', () => {
    registerParser(makeStubParser('WDL', makeGraph()));
    expect(() => registerParser(makeStubParser('WDL', makeGraph()))).toThrow();
  });
});

describe('parseDefinition dispatcher', () => {
  beforeEach(() => {
    clearParsers();
  });

  it('dispatches to the registered parser and validates the graph', () => {
    const graph = makeGraph();
    registerParser(makeStubParser('WDL', graph));
    expect(parseDefinition(makeDef({ language: 'WDL' }))).toBe(graph);
  });

  it('rejects an unsupported language with workflowId and reason', () => {
    try {
      parseDefinition(makeDef({ workflowId: 'wf-x', language: 'SMK' }));
      throw new Error('expected ParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).workflowId).toBe('wf-x');
      expect((err as ParseError).reason).toContain('unsupported language');
    }
  });

  it('rejects a supported language with no registered parser', () => {
    expect(() => parseDefinition(makeDef({ language: 'CWL' }))).toThrow(
      ParseError,
    );
  });

  it('rejects when the parser reports it cannot parse', () => {
    registerParser(makeStubParser('NEXTFLOW', makeGraph(), false));
    expect(() =>
      parseDefinition(makeDef({ language: 'NEXTFLOW' })),
    ).toThrow(ParseError);
  });

  it('rejects when the parser produces a cyclic graph', () => {
    const cyclic = makeGraph({
      workflowId: 'wf-c',
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    registerParser(makeStubParser('WDL', cyclic));
    expect(() =>
      parseDefinition(makeDef({ workflowId: 'wf-c', language: 'WDL' })),
    ).toThrow(ParseError);
  });
});
