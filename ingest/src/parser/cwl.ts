/**
 * CWL (Common Workflow Language) definition parser.
 *
 * Parses a CWL workflow document into a {@link StaticGraph}: one node per
 * workflow `step`, and one directed producer → consumer edge for each step
 * connection derived from the consuming step's `in`/`source` references back to
 * a producing step's `out` output (Req 6.7).
 *
 * CWL is expressed as YAML or JSON. Because JSON is a strict subset of YAML,
 * both forms are handled by the same YAML loader. All CWL-shape assumptions are
 * isolated in this module so they can be adjusted in one place.
 *
 * ## Single-entry-document parser, `exact` fidelity
 *
 * CWL is parsed as a **single entry document**: the parser loads only the entry
 * file named by `mainPath` (via {@link readMain}), never the rest of the
 * File_Map. Cross-file CWL references (`run:` pointing at other documents) are
 * out of scope for this feature; the entry document's `steps` and their
 * `in`/`source` connections are the node/edge inventory. Because CWL `in.source`
 * references express real, authoritative producer→consumer dataflow within that
 * entry document, a successfully parsed graph is marked `fidelity: 'exact'`
 * (Req 2.5, 4.6; design §4a). A missing entry file is surfaced by
 * {@link readMain}, which throws a {@link ParseError} naming the `workflowId`
 * (Req 2.2) — this module adds no redundant presence check.
 *
 * This module registers its parser against the shared parser registry as a
 * module-level side effect, mirroring the WDL and Nextflow parsers (Req 6.12).
 * Importing this module is sufficient to make the CWL parser available to
 * {@link parseDefinition}.
 *
 * Mirrors the CWL portion of the "Workflow Definition Parser Module" section of
 * design.md.
 */

import yaml from 'js-yaml';
import {
  ParseError,
  readMain,
  registerParser,
  type DefinitionParser,
  type GraphEdge,
  type GraphNode,
  type StaticGraph,
  type WorkflowDefinition,
} from './types.js';

/**
 * A single CWL workflow step as consumed by the parser. Fields not relevant to
 * graph construction (e.g. `run`) are ignored.
 */
interface CwlStep {
  /** The step's identifier within the workflow. */
  id: string;
  /**
   * Output names this step produces. Other steps reference these as
   * `<stepId>/<outputName>` in their `in.*.source` connections.
   */
  outputs: string[];
  /**
   * Source references pulled from the step's `in` connections. Each entry is a
   * raw CWL source string that may reference another step's output.
   */
  sources: string[];
}

/**
 * Strip a leading CWL document fragment marker (`#`) from a reference.
 *
 * CWL identifiers are sometimes written as absolute references such as
 * `#stepId/outputName`; the leading `#` is not part of the step id.
 */
function stripFragment(reference: string): string {
  return reference.startsWith('#') ? reference.slice(1) : reference;
}

/**
 * Given a CWL `source` reference and the set of known step ids, return the
 * producing step id when the reference points at a step output, or `undefined`
 * when it references a workflow-level input (no producing step).
 *
 * A source pointing at a step output has the form `<stepId>/<outputName>`.
 * References without a `/` (or whose leading segment is not a known step) are
 * workflow inputs and produce no dependency edge.
 */
function resolveProducerStep(
  source: string,
  stepIds: ReadonlySet<string>,
): string | undefined {
  const normalized = stripFragment(source);
  const slash = normalized.indexOf('/');
  if (slash === -1) {
    // No `/` component: references a workflow input, not a step output.
    return undefined;
  }
  const candidate = normalized.slice(0, slash);
  return stepIds.has(candidate) ? candidate : undefined;
}

/**
 * Coerce a CWL value that may be a single string or a list of strings into a
 * flat array of strings, ignoring non-string entries.
 */
function toStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

/**
 * Extract the `source` reference strings from a step's `in` connections.
 *
 * CWL `in` may be a map (`{ inputId: source | { source } }`) or a list
 * (`[{ id, source }]`). `source` itself may be a string or a list of strings.
 */
function extractSources(inValue: unknown): string[] {
  const sources: string[] = [];

  const collectFromEntry = (entry: unknown): void => {
    if (typeof entry === 'string') {
      // Shorthand: `inputId: sourceRef`.
      sources.push(...toStringList(entry));
      return;
    }
    if (entry && typeof entry === 'object') {
      const source = (entry as Record<string, unknown>).source;
      sources.push(...toStringList(source));
    }
  };

  if (Array.isArray(inValue)) {
    for (const entry of inValue) {
      collectFromEntry(entry);
    }
  } else if (inValue && typeof inValue === 'object') {
    for (const entry of Object.values(inValue as Record<string, unknown>)) {
      collectFromEntry(entry);
    }
  }

  return sources;
}

/**
 * Extract the output names a step produces from its `out` declaration.
 *
 * CWL `out` is typically a list whose entries are output-name strings or
 * objects carrying an `id`. The names are used only for informational purposes;
 * dependency edges are keyed on the producing step id, so a missing or
 * malformed `out` does not prevent edge construction.
 */
function extractOutputs(outValue: unknown): string[] {
  const outputs: string[] = [];
  if (Array.isArray(outValue)) {
    for (const entry of outValue) {
      if (typeof entry === 'string') {
        outputs.push(stripFragment(entry));
      } else if (entry && typeof entry === 'object') {
        const id = (entry as Record<string, unknown>).id;
        if (typeof id === 'string') {
          outputs.push(stripFragment(id));
        }
      }
    }
  }
  return outputs;
}

/**
 * Normalize the workflow document's `steps` (map or list form) into a list of
 * {@link CwlStep}. Throws {@link ParseError} when a step lacks a usable id.
 */
function normalizeSteps(
  workflowId: string,
  stepsValue: unknown,
): CwlStep[] {
  const steps: CwlStep[] = [];

  const buildStep = (id: string, body: unknown): CwlStep => {
    const record = (body && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    return {
      id,
      outputs: extractOutputs(record.out),
      sources: extractSources(record.in),
    };
  };

  if (Array.isArray(stepsValue)) {
    // List form: each entry carries its own `id`.
    for (const entry of stepsValue) {
      if (!entry || typeof entry !== 'object') {
        throw new ParseError(
          workflowId,
          'CWL step list entry is not an object',
        );
      }
      const id = (entry as Record<string, unknown>).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ParseError(
          workflowId,
          'CWL step in list form is missing a non-empty "id"',
        );
      }
      steps.push(buildStep(stripFragment(id), entry));
    }
  } else if (stepsValue && typeof stepsValue === 'object') {
    // Map form: the key is the step id.
    for (const [id, body] of Object.entries(
      stepsValue as Record<string, unknown>,
    )) {
      if (id.length === 0) {
        throw new ParseError(workflowId, 'CWL step has an empty id');
      }
      steps.push(buildStep(id, body));
    }
  } else {
    throw new ParseError(
      workflowId,
      'CWL workflow "steps" is missing or not a map/list',
    );
  }

  return steps;
}

/**
 * Load a CWL definition source (YAML or JSON) into a plain object.
 *
 * Throws {@link ParseError} identifying the `workflowId` when the source is not
 * valid YAML/JSON or does not parse to a document object.
 */
function loadDocument(def: WorkflowDefinition): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = yaml.load(readMain(def));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ParseError(def.workflowId, `invalid CWL document: ${reason}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ParseError(
      def.workflowId,
      'CWL document did not parse to an object',
    );
  }
  return doc as Record<string, unknown>;
}

/**
 * Parse a CWL {@link WorkflowDefinition} into a {@link StaticGraph}.
 *
 * Steps become nodes; for each source reference in a consuming step's `in` that
 * resolves to another step's output, a producer → consumer edge is created
 * (Req 6.7). Duplicate edges (a step consuming several outputs of the same
 * producer) are collapsed to a single edge.
 */
function parseCwl(def: WorkflowDefinition): StaticGraph {
  const doc = loadDocument(def);
  const steps = normalizeSteps(def.workflowId, doc.steps);

  const nodes: GraphNode[] = steps.map((step) => ({
    id: step.id,
    name: step.id,
  }));

  const stepIds = new Set(steps.map((step) => step.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const step of steps) {
    for (const source of step.sources) {
      const producer = resolveProducerStep(source, stepIds);
      // Skip workflow-input sources and any self-reference.
      if (producer === undefined || producer === step.id) {
        continue;
      }
      const key = `${producer}\u0000${step.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ from: producer, to: step.id });
    }
  }

  // CWL edges come directly from explicit `source` connections, so the produced
  // graph is authoritative (Req 4.6; task 4.1 confirms this).
  return { workflowId: def.workflowId, nodes, edges, fidelity: 'exact' };
}

/**
 * The single CWL {@link DefinitionParser}. `canParse` accepts any definition
 * declared as `CWL`; structural validation happens in {@link parseCwl} and the
 * shared graph-invariant check.
 */
export const cwlParser: DefinitionParser = {
  language: 'CWL',
  canParse: (def: WorkflowDefinition): boolean => def.language === 'CWL',
  parse: parseCwl,
};

// Module-level side-effect registration, consistent with the WDL and Nextflow
// parsers (Req 6.12). Importing this module makes the CWL parser available to
// the dispatcher.
registerParser(cwlParser);
