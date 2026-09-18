import { describe, it, expect, beforeEach } from 'vitest';
import {
  ParseError,
  clearParsers,
  registerParser,
  parseDefinition,
  assertValidGraph,
  type StaticGraph,
  type WorkflowDefinition,
} from '../../src/parser/types.js';
import { nextflowParser } from '../../src/parser/nextflow.js';
import {
  NFCORE_FILES,
  NFCORE_MAIN_PATH,
  NFCORE_EXPECTED_NODES,
  NFCORE_EXPECTED_EDGES,
} from './fixtures/nfcore.js';

function makeDef(source: string, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflowId: 'wf-nf',
    language: 'NEXTFLOW',
    files: { 'main.nf': source },
    mainPath: 'main.nf',
    ...overrides,
  };
}

/** Sort edges for order-independent comparison. */
function sortEdges(graph: StaticGraph): { from: string; to: string }[] {
  return [...graph.edges].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
}

/** A small but representative DSL2 Nextflow pipeline: A -> B -> C, plus A -> C. */
const SAMPLE = `
// Example Nextflow DSL2 pipeline
nextflow.enable.dsl = 2

process FOO {
  output:
    path 'foo.txt', emit: fooOut

  script:
  """
  echo foo > foo.txt
  """
}

process BAR {
  input:
    path x
  output:
    path 'bar.txt', emit: barOut

  script:
  """
  cat \${x} > bar.txt
  """
}

process BAZ {
  input:
    path a
    path b
  output:
    path 'baz.txt'

  script:
  """
  cat \${a} \${b} > baz.txt
  """
}

workflow {
  FOO()
  BAR(FOO.out.fooOut)
  BAZ(FOO.out.fooOut, BAR.out.barOut)
}
`;

describe('nextflowParser.parse', () => {
  it('creates one node per process declaration', () => {
    const graph = nextflowParser.parse(makeDef(SAMPLE));
    const names = graph.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['BAR', 'BAZ', 'FOO']);
    // Node id and name coincide for Nextflow processes.
    for (const node of graph.nodes) {
      expect(node.id).toBe(node.name);
    }
  });

  it('creates a producer -> consumer edge for each process-to-process channel connection', () => {
    const graph = nextflowParser.parse(makeDef(SAMPLE));
    expect(sortEdges(graph)).toEqual([
      { from: 'BAR', to: 'BAZ' },
      { from: 'FOO', to: 'BAR' },
      { from: 'FOO', to: 'BAZ' },
    ]);
  });

  it('resolves channels bound to local variables', () => {
    const source = `
      process A { output: path 'a', emit: out }
      process B { input: path x \n output: path 'b', emit: out }
      workflow {
        ch = A.out
        B(ch)
      }
    `;
    const graph = nextflowParser.parse(makeDef(source, { workflowId: 'wf-alias' }));
    expect(sortEdges(graph)).toEqual([{ from: 'A', to: 'B' }]);
  });

  it('ignores calls to non-process functions', () => {
    const source = `
      process A { output: path 'a', emit: out }
      workflow {
        Channel.fromPath('x')
        A()
      }
    `;
    const graph = nextflowParser.parse(makeDef(source, { workflowId: 'wf-fn' }));
    expect(graph.nodes.map((n) => n.name)).toEqual(['A']);
    expect(graph.edges).toEqual([]);
  });

  it('does not emit self-loops', () => {
    // A process referencing its own output in an argument must not self-edge.
    const source = `
      process A { output: path 'a', emit: out }
      workflow {
        A(A.out)
      }
    `;
    const graph = nextflowParser.parse(makeDef(source, { workflowId: 'wf-self' }));
    expect(graph.edges).toEqual([]);
  });

  it('handles a definition with no workflow block (nodes, no edges)', () => {
    const source = `
      process A { output: path 'a' }
      process B { output: path 'b' }
    `;
    const graph = nextflowParser.parse(makeDef(source, { workflowId: 'wf-nowf' }));
    expect(graph.nodes.map((n) => n.name).sort()).toEqual(['A', 'B']);
    expect(graph.edges).toEqual([]);
  });

  it('produces a graph that passes acyclicity/node-count validation', () => {
    const graph = nextflowParser.parse(makeDef(SAMPLE));
    expect(() => assertValidGraph(graph)).not.toThrow();
  });

  it('canParse only accepts NEXTFLOW definitions', () => {
    expect(nextflowParser.canParse(makeDef(SAMPLE))).toBe(true);
    expect(nextflowParser.canParse(makeDef(SAMPLE, { language: 'WDL' }))).toBe(false);
  });
});

describe('nextflowParser fidelity (Req 4.6, 4.7)', () => {
  it('marks a trivial single-file, single-process workflow with no wiring as exact', () => {
    // GreetingsNF-style: one process, no channel wiring to interpret.
    const source = `
      nextflow.enable.dsl = 2
      process SAY_HELLO {
        output: path 'greeting.txt'
        script:
        """
        echo hello > greeting.txt
        """
      }
      workflow {
        SAY_HELLO()
      }
    `;
    const graph = nextflowParser.parse(makeDef(source, { workflowId: 'wf-greet' }));
    expect(graph.nodes.map((n) => n.name)).toEqual(['SAY_HELLO']);
    expect(graph.edges).toEqual([]);
    expect(graph.fidelity).toBe('exact');
  });

  it('marks a wired single-file multi-process workflow as approximate', () => {
    // SAMPLE has inferred process-to-process edges, so it is not authoritative.
    const graph = nextflowParser.parse(makeDef(SAMPLE));
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.fidelity).toBe('approximate');
  });

  it('marks a single-file multi-process workflow with no edges as approximate', () => {
    // Two processes but no channel wiring: still approximate because exact is
    // reserved for the single-process trivial case (edges could exist and be
    // missed by the heuristic once there is more than one node).
    const source = `
      process A { output: path 'a' }
      process B { output: path 'b' }
      workflow {
        A()
        B()
      }
    `;
    const graph = nextflowParser.parse(makeDef(source, { workflowId: 'wf-two' }));
    expect(graph.edges).toEqual([]);
    expect(graph.fidelity).toBe('approximate');
  });
});

describe('nextflow multi-file subworkflow edges (Req 4.2)', () => {
  it('treats named subworkflows as first-class producers and consumers across files', () => {
    const files: Record<string, string> = {
      'main.nf': `
        include { PREP } from './subworkflows/prep'
        include { ANALYZE } from './modules/analyze'
        workflow {
          PREP()
          ANALYZE(PREP.out)
        }
      `,
      'subworkflows/prep/main.nf': `
        include { FETCH } from '../../modules/fetch'
        workflow PREP {
          take:
            nothing
          main:
            FETCH()
          emit:
            FETCH.out
        }
      `,
      'modules/fetch/main.nf': `
        process FETCH { output: path 'f', emit: out }
      `,
      'modules/analyze/main.nf': `
        process ANALYZE { input: path x \n output: path 'a', emit: out }
      `,
    };
    const graph = nextflowParser.parse({
      workflowId: 'wf-multi',
      language: 'NEXTFLOW',
      files,
      mainPath: 'main.nf',
    });

    expect(graph.nodes.map((n) => n.name).sort()).toEqual([
      'ANALYZE',
      'FETCH',
      'PREP',
    ]);
    // PREP (a subworkflow) is a producer feeding ANALYZE (a consumer).
    expect(sortEdges(graph)).toContainEqual({ from: 'PREP', to: 'ANALYZE' });
    // Spanning multiple resolved files makes this approximate (Req 4.7).
    expect(graph.fidelity).toBe('approximate');
    expect(() => assertValidGraph(graph)).not.toThrow();
  });
});

describe('nf-core-style fixture self-check (Req 3.1, 3.2, 3.3, 4.2)', () => {
  it('yields the fixture-declared nodes, edges, and approximate fidelity', () => {
    const graph = nextflowParser.parse({
      workflowId: 'wf-nfcore',
      language: 'NEXTFLOW',
      files: NFCORE_FILES,
      mainPath: NFCORE_MAIN_PATH,
    });

    // Node inventory is the deduped process + named-subworkflow union across
    // every reachable file, resolved transitively through the module-directory
    // include convention (Req 3.1, 3.2, 3.3).
    expect(graph.nodes.map((n) => n.name).sort()).toEqual(NFCORE_EXPECTED_NODES);

    // The linear INPUT_CHECK -> FASTQC -> MULTIQC backbone yields exactly the
    // documented best-effort edges (Req 4.2).
    expect(sortEdges(graph)).toEqual(NFCORE_EXPECTED_EDGES);

    // A multi-file, include-following graph is never authoritative (Req 4.7).
    expect(graph.fidelity).toBe('approximate');

    // The produced graph is acyclic / well-formed.
    expect(() => assertValidGraph(graph)).not.toThrow();
  });
});

describe('nextflow parser registration and dispatch', () => {
  beforeEach(() => {
    clearParsers();
    registerParser(nextflowParser);
  });

  it('is dispatched by language via parseDefinition', () => {
    const graph = parseDefinition(makeDef(SAMPLE));
    expect(graph.workflowId).toBe('wf-nf');
    expect(graph.nodes.map((n) => n.name).sort()).toEqual(['BAR', 'BAZ', 'FOO']);
  });

  it('rejects a cyclic pipeline with a ParseError identifying the workflowId', () => {
    const source = `
      process A { input: path y \n output: path 'a', emit: out }
      process B { input: path x \n output: path 'b', emit: out }
      workflow {
        A(B.out)
        B(A.out)
      }
    `;
    try {
      parseDefinition(makeDef(source, { workflowId: 'wf-cycle' }));
      throw new Error('expected ParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).workflowId).toBe('wf-cycle');
      expect((err as ParseError).reason).toContain('cycle');
    }
  });
});
