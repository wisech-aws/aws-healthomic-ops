import { describe, it, expect } from 'vitest';
import { cwlParser } from '../../src/parser/cwl.js';
import { parseDefinition, ParseError } from '../../src/parser/types.js';
import type { WorkflowDefinition } from '../../src/parser/types.js';

// Importing `../../src/parser/cwl.js` registers the CWL parser against the
// shared registry as a module-level side effect, so `parseDefinition` can
// dispatch CWL definitions without any further wiring.

function makeDef(source: string, overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflowId: 'wf-cwl-1',
    language: 'CWL',
    files: { 'main.cwl': source },
    mainPath: 'main.cwl',
    ...overrides,
  };
}

/**
 * A small linear CWL workflow in map form:
 *   untar (consumes a workflow input) -> compile (consumes untar's output)
 */
const LINEAR_CWL_YAML = `
cwlVersion: v1.2
class: Workflow
inputs:
  tarball: File
outputs:
  compiled:
    type: File
    outputSource: compile/classfile
steps:
  untar:
    run: tar-param.cwl
    in:
      tarfile: tarball
    out: [extracted]
  compile:
    run: arguments.cwl
    in:
      src:
        source: untar/extracted
    out: [classfile]
`;

/** A diamond CWL workflow in list form, with sources as string lists. */
const DIAMOND_CWL_YAML = `
cwlVersion: v1.2
class: Workflow
inputs:
  in1: File
steps:
  - id: a
    run: a.cwl
    in:
      x: in1
    out: [oa]
  - id: b
    run: b.cwl
    in:
      x:
        source: a/oa
    out: [ob]
  - id: c
    run: c.cwl
    in:
      x:
        source: a/oa
    out: [oc]
  - id: d
    run: d.cwl
    in:
      inputs:
        source: [b/ob, c/oc]
    out: [od]
`;

describe('cwlParser', () => {
  it('declares CWL as its language and only accepts CWL definitions', () => {
    expect(cwlParser.language).toBe('CWL');
    expect(cwlParser.canParse(makeDef(LINEAR_CWL_YAML))).toBe(true);
    expect(cwlParser.canParse(makeDef(LINEAR_CWL_YAML, { language: 'WDL' }))).toBe(
      false,
    );
  });

  it('parses steps as nodes and in/source connections as producer -> consumer edges', () => {
    const graph = cwlParser.parse(makeDef(LINEAR_CWL_YAML));
    expect(graph.workflowId).toBe('wf-cwl-1');
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['compile', 'untar']);
    // Node names mirror step ids for frontend name-matching.
    expect(graph.nodes.find((n) => n.id === 'untar')?.name).toBe('untar');
    // untar -> compile; the workflow-input source (`tarball`) yields no edge.
    expect(graph.edges).toEqual([{ from: 'untar', to: 'compile' }]);
  });

  it('parses list-form steps and list-valued sources into a diamond DAG', () => {
    const graph = cwlParser.parse(makeDef(DIAMOND_CWL_YAML, { workflowId: 'wf-d' }));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    const edgeSet = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet).toEqual(
      new Set(['a->b', 'a->c', 'b->d', 'c->d']),
    );
  });

  it('accepts JSON-form CWL (JSON is a subset of YAML)', () => {
    const json = JSON.stringify({
      cwlVersion: 'v1.2',
      class: 'Workflow',
      steps: {
        first: { in: { x: 'wfInput' }, out: ['o'] },
        second: { in: { y: { source: 'first/o' } }, out: ['o2'] },
      },
    });
    const graph = cwlParser.parse(makeDef(json, { workflowId: 'wf-json' }));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['first', 'second']);
    expect(graph.edges).toEqual([{ from: 'first', to: 'second' }]);
  });

  it('collapses multiple outputs from the same producer into a single edge', () => {
    const yaml = `
class: Workflow
steps:
  prod:
    in:
      x: wfInput
    out: [o1, o2]
  cons:
    in:
      a:
        source: prod/o1
      b:
        source: prod/o2
    out: [oc]
`;
    const graph = cwlParser.parse(makeDef(yaml, { workflowId: 'wf-dedup' }));
    expect(graph.edges).toEqual([{ from: 'prod', to: 'cons' }]);
  });

  it('ignores fragment-prefixed references (#step/output)', () => {
    const yaml = `
class: Workflow
steps:
  s1:
    in:
      x: '#wfInput'
    out: [out1]
  s2:
    in:
      y:
        source: '#s1/out1'
    out: [out2]
`;
    const graph = cwlParser.parse(makeDef(yaml, { workflowId: 'wf-frag' }));
    expect(graph.edges).toEqual([{ from: 's1', to: 's2' }]);
  });

  it('dispatches CWL definitions through parseDefinition and validates the graph', () => {
    const graph = parseDefinition(makeDef(LINEAR_CWL_YAML));
    expect(graph.edges).toEqual([{ from: 'untar', to: 'compile' }]);
  });

  it('rejects a definition with no steps with a ParseError naming the workflow', () => {
    try {
      cwlParser.parse(makeDef('class: Workflow\ninputs: {}\n', { workflowId: 'wf-nosteps' }));
      throw new Error('expected ParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).workflowId).toBe('wf-nosteps');
      expect((err as ParseError).reason).toContain('steps');
    }
  });

  it('rejects invalid YAML with a ParseError', () => {
    expect(() =>
      cwlParser.parse(makeDef('steps: [unclosed', { workflowId: 'wf-bad' })),
    ).toThrow(ParseError);
  });

  it('rejects a cyclic workflow via parseDefinition graph validation', () => {
    const cyclic = `
class: Workflow
steps:
  a:
    in:
      x:
        source: b/ob
    out: [oa]
  b:
    in:
      y:
        source: a/oa
    out: [ob]
`;
    expect(() =>
      parseDefinition(makeDef(cyclic, { workflowId: 'wf-cycle' })),
    ).toThrow(ParseError);
  });
});
