/**
 * Workflow Definition Parser module — shared types and dispatcher.
 *
 * This file defines the common interface every language parser implements, the
 * graph value types a parser produces, the error type parsers throw on failure,
 * and a dispatcher that selects the single parser registered for a definition's
 * language.
 *
 * The parser is an isolated module exposing exactly one `DefinitionParser`
 * implementation per supported language behind this common interface (Req 6.12).
 * The language-specific parsing logic (WDL, Nextflow, CWL) lives in separate
 * modules (tasks 6.2, 6.3, 6.4) that register themselves against the parser
 * registry exposed here. This file intentionally contains no language-specific
 * parsing logic.
 *
 * Mirrors the "Definition parser interface" and "Workflow Definition Parser
 * Module" sections of design.md.
 */

/**
 * Supported workflow definition languages.
 *
 * A definition whose language is not one of these is unsupported and MUST be
 * rejected with a {@link ParseError} (Req 6.4).
 */
export type Language = 'WDL' | 'NEXTFLOW' | 'CWL';

/** All supported languages, in a stable order, for iteration and validation. */
export const SUPPORTED_LANGUAGES: readonly Language[] = ['WDL', 'NEXTFLOW', 'CWL'];

/**
 * Type guard: is the given value one of the supported {@link Language} values?
 */
export function isSupportedLanguage(value: unknown): value is Language {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

/**
 * A workflow task in the static graph. One node per workflow task (Req 6.3).
 *
 * `id` is the stable, definition-internal identifier used to reference the node
 * within {@link GraphEdge}s. `name` is the task name the frontend matches
 * against live run tasks by exact, case-sensitive equality (Req 6.10).
 */
export interface GraphNode {
  id: string;
  name: string;
}

/**
 * A directed dependency edge between two {@link GraphNode}s.
 *
 * Orientation is producer → consumer: `from` is the node that produces an
 * output and `to` is the node that consumes it as input (Req 6.3, 6.5–6.7).
 */
export interface GraphEdge {
  /** Node id of the producer. */
  from: string;
  /** Node id of the consumer. */
  to: string;
}

/**
 * How complete a produced {@link StaticGraph} is (Req 4.6, 4.7):
 *
 * - `exact` — edges are complete and authoritative for the definition.
 * - `approximate` — the node inventory is reliable but edges are best-effort.
 */
export type Fidelity = 'exact' | 'approximate';

/**
 * The parsed static task graph derived from a {@link WorkflowDefinition},
 * keyed by `workflowId` (Req 6.3, 6.8).
 */
export interface StaticGraph {
  workflowId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** How complete the produced graph is (Req 4.6, 4.7). */
  fidelity: Fidelity;
}

/**
 * A workflow definition retrieved from HealthOmics `GetWorkflow`, as supplied to
 * a parser.
 *
 * The exact `GetWorkflow` field holding the definition bundle (a presigned URL
 * to `definition.zip`) is confirmed and resolved by the enrichment layer
 * (`getWorkflowDefinition()` in `ingest/src/enrichment/workflow.ts`); by the
 * time a definition reaches the parser it is normalized into this shape, with
 * the bundle downloaded and unzipped into an in-memory File_Map so parsers can
 * resolve multi-file workflows (Req 2.1, 2.2).
 */
export interface WorkflowDefinition {
  /** The workflow this definition belongs to; echoed into errors and graphs. */
  workflowId: string;
  /** Declared definition language. May be an unsupported value (Req 6.4). */
  language: Language | string;
  /**
   * The File_Map: archive-relative path -> file contents, produced by unzipping
   * the definition bundle in memory (Req 2.1).
   */
  files: Record<string, string>;
  /**
   * The Main_Path: the archive-relative path of the workflow entry file within
   * {@link WorkflowDefinition.files} (Req 2.2).
   */
  mainPath: string;
}

/**
 * Read the entry (`mainPath`) file contents from a definition's File_Map.
 *
 * Shared by the single-file parsers (WDL/CWL) so they can consume the entry
 * document without knowing about the File_Map layout. Throws a
 * {@link ParseError} identifying the `workflowId` when the entry file is absent
 * from the map (Req 2.2).
 */
export function readMain(def: WorkflowDefinition): string {
  const content = def.files[def.mainPath];
  if (content === undefined) {
    throw new ParseError(
      def.workflowId,
      `main definition file "${def.mainPath}" not found in bundle`,
    );
  }
  return content;
}

/**
 * Error thrown when a definition cannot be turned into a valid
 * {@link StaticGraph}: it cannot be parsed, uses an unsupported language, or
 * produces a graph containing a cycle (Req 6.4).
 *
 * Carries the `workflowId` and a human-readable `reason` so the caller can
 * record an error indication identifying the failed workflow (Req 6.4).
 */
export class ParseError extends Error {
  readonly workflowId: string;
  readonly reason: string;

  constructor(workflowId: string, reason: string) {
    super(`Failed to parse workflow ${workflowId}: ${reason}`);
    this.name = 'ParseError';
    this.workflowId = workflowId;
    this.reason = reason;
    // Restore prototype chain for instanceof checks under transpilation.
    Object.setPrototypeOf(this, ParseError.prototype);
  }
}

/**
 * The common interface every language parser implements (Req 6.12).
 *
 * `parse` MUST return a valid acyclic {@link StaticGraph} or throw a
 * {@link ParseError} identifying the `workflowId` and reason (Req 6.4).
 */
export interface DefinitionParser {
  /** The single language this parser handles. */
  language: Language;
  /** Whether this parser can handle the given definition. */
  canParse(def: WorkflowDefinition): boolean;
  /** Parse into a StaticGraph; throws {@link ParseError} on cycle/unsupported. */
  parse(def: WorkflowDefinition): StaticGraph;
}

/**
 * Detect whether the directed graph described by `edges` over `nodes` contains
 * a cycle.
 *
 * Uses an iterative depth-first traversal with three-color marking so it does
 * not overflow the stack on large graphs. Edges that reference unknown node ids
 * are treated as connecting only the nodes that exist; a self-loop
 * (`from === to`) counts as a cycle.
 *
 * @returns `true` if any cycle is reachable, otherwise `false`.
 */
export function hasCycle(nodes: GraphNode[], edges: GraphEdge[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    // Only consider edges whose producer is a known node; the consumer is
    // recorded even if unknown so a self-loop on a known node is still caught.
    const outgoing = adjacency.get(edge.from);
    if (outgoing) {
      outgoing.push(edge.to);
    }
  }

  // 0 = unvisited, 1 = in progress (on current stack), 2 = fully explored.
  const color = new Map<string, number>();
  for (const node of nodes) {
    color.set(node.id, 0);
  }

  for (const node of nodes) {
    if (color.get(node.id) !== 0) {
      continue;
    }
    // Iterative DFS. Each frame tracks a node and the index of the next
    // neighbor to visit.
    const stack: { id: string; index: number }[] = [{ id: node.id, index: 0 }];
    color.set(node.id, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adjacency.get(frame.id) ?? [];
      if (frame.index < neighbors.length) {
        const next = neighbors[frame.index];
        frame.index += 1;
        const nextColor = color.get(next);
        if (nextColor === undefined) {
          // Edge to an unknown node id; nothing to traverse.
          continue;
        }
        if (nextColor === 1) {
          // Back edge to a node on the current stack -> cycle.
          return true;
        }
        if (nextColor === 0) {
          color.set(next, 1);
          stack.push({ id: next, index: 0 });
        }
      } else {
        color.set(frame.id, 2);
        stack.pop();
      }
    }
  }

  return false;
}

/**
 * Validate a produced {@link StaticGraph} against the invariants every parser
 * must uphold, throwing a {@link ParseError} identifying the `workflowId` and
 * reason on any violation (Req 6.3, 6.4):
 *
 * - node ids are unique and non-empty (one node per task),
 * - every edge endpoint references an existing node,
 * - the graph is acyclic.
 *
 * The graph's `fidelity` is carried through unchanged — it is not part of the
 * structural invariants (Req 4.4, 4.5). Returns the same graph (including its
 * `fidelity`) for convenient chaining when it is valid.
 */
export function assertValidGraph(graph: StaticGraph): StaticGraph {
  const { workflowId, nodes, edges } = graph;
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.id.length === 0) {
      throw new ParseError(workflowId, 'graph contains a node with an empty id');
    }
    if (ids.has(node.id)) {
      throw new ParseError(
        workflowId,
        `graph contains duplicate node id "${node.id}"`,
      );
    }
    ids.add(node.id);
  }

  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new ParseError(
        workflowId,
        `edge references unknown node ("${edge.from}" -> "${edge.to}")`,
      );
    }
  }

  if (hasCycle(nodes, edges)) {
    throw new ParseError(workflowId, 'graph contains a cycle');
  }

  return graph;
}

/**
 * A registry mapping each supported {@link Language} to its single
 * {@link DefinitionParser} implementation.
 *
 * The language-specific parser modules (tasks 6.2–6.4) register themselves here
 * via {@link registerParser}. The registry enforces the "exactly one parser per
 * language" invariant (Req 6.12) by rejecting duplicate registrations.
 */
const parserRegistry = new Map<Language, DefinitionParser>();

/**
 * Register the single parser implementation for a language.
 *
 * Throws if a parser is already registered for the parser's language, or if the
 * parser's declared `language` is not supported. This keeps exactly one parser
 * per language (Req 6.12).
 */
export function registerParser(parser: DefinitionParser): void {
  if (!isSupportedLanguage(parser.language)) {
    throw new Error(
      `Cannot register parser for unsupported language "${parser.language}"`,
    );
  }
  if (parserRegistry.has(parser.language)) {
    throw new Error(
      `A parser is already registered for language "${parser.language}"`,
    );
  }
  parserRegistry.set(parser.language, parser);
}

/**
 * Return the parser registered for a language, or `undefined` if none is
 * registered. Exposed primarily for testing and introspection.
 */
export function getParser(language: Language): DefinitionParser | undefined {
  return parserRegistry.get(language);
}

/**
 * Remove all registered parsers. Intended for test isolation only.
 */
export function clearParsers(): void {
  parserRegistry.clear();
}

/**
 * Parse a {@link WorkflowDefinition} into a validated {@link StaticGraph} by
 * dispatching to the parser registered for the definition's language.
 *
 * Rejects with a {@link ParseError} identifying the `workflowId` and reason when
 * the language is unsupported or has no registered parser, when the selected
 * parser reports it cannot parse the definition, or when parsing/validation
 * fails (unparseable, cyclic, or malformed graph) (Req 6.3, 6.4, 6.12).
 */
export function parseDefinition(def: WorkflowDefinition): StaticGraph {
  if (!isSupportedLanguage(def.language)) {
    throw new ParseError(
      def.workflowId,
      `unsupported language "${def.language}"`,
    );
  }

  const parser = parserRegistry.get(def.language);
  if (!parser) {
    throw new ParseError(
      def.workflowId,
      `no parser registered for language "${def.language}"`,
    );
  }

  if (!parser.canParse(def)) {
    throw new ParseError(
      def.workflowId,
      `parser for language "${def.language}" cannot parse this definition`,
    );
  }

  // The parser may throw ParseError itself; enforce graph invariants regardless
  // so acyclicity and node-count guarantees hold for every language (Req 6.4).
  const graph = parser.parse(def);
  return assertValidGraph(graph);
}
