/**
 * WDL Workflow Definition parser.
 *
 * Parses a WDL (Workflow Description Language) definition into a
 * {@link StaticGraph}: one node per `call` statement, and a directed edge from
 * each call that produces an output reference to every call that consumes that
 * reference as input (producer → consumer, Req 6.5).
 *
 * ## Approach
 *
 * WDL wires tasks together by referencing one call's outputs inside another
 * call's inputs. Within a `workflow { ... }` block, a call looks like:
 *
 * ```wdl
 * call alignReads { input: reads = fastqc.trimmed }
 * call fastqc as qc { input: fastq = raw }
 * ```
 *
 * A reference of the form `<callName>.<output>` (e.g. `fastqc.trimmed`) inside a
 * consuming call's input expressions establishes a dependency edge from the
 * producing call (`fastqc`) to the consuming call. The producing call is
 * identified by its *invocation name* — the alias when `call X as Y` is used
 * (`Y`), otherwise the (possibly dotted) task name's final segment.
 *
 * This is a pragmatic, dependency-focused parser rather than a full WDL grammar
 * implementation: it recognizes `call` statements and the `name.output`
 * reference form that expresses inter-call data flow, which is what the static
 * graph needs (Req 6.5). It does not attempt to evaluate expressions, scatter
 * bodies, or conditionals beyond collecting the calls they contain.
 *
 * ## Single-entry-document parser, `exact` fidelity
 *
 * WDL is parsed as a **single entry document**: the parser reads only the entry
 * file named by `mainPath` (via {@link readMain}), never the rest of the
 * File_Map. Cross-file WDL `import` chaining is explicitly **out of scope** for
 * this feature — a `call` names its invocation locally, so the node inventory is
 * complete from the entry document even when task bodies are imported. Because
 * WDL `call` inputs express real, authoritative producer→consumer dataflow
 * within that entry document, a successfully parsed graph is marked
 * `fidelity: 'exact'` (Req 2.4, 4.6; design §4a).
 *
 * On failure (no calls, or a reference structure that yields a cycle) the parser
 * throws a {@link ParseError}; the dispatcher additionally re-validates the
 * produced graph for acyclicity and well-formedness (Req 6.4). A missing entry
 * file is surfaced by {@link readMain}, which throws a {@link ParseError} naming
 * the `workflowId` (Req 2.2) — the parser adds no redundant presence check.
 */

import {
  type DefinitionParser,
  type GraphEdge,
  type GraphNode,
  type StaticGraph,
  type WorkflowDefinition,
  ParseError,
  getParser,
  readMain,
  registerParser,
} from './types.js';

/** The language this parser handles. */
const LANGUAGE = 'WDL' as const;

/**
 * Strip WDL comments (`# ...` to end of line) so they cannot be mistaken for
 * call statements or references. String literals are left intact; comment
 * detection is line-based, matching WDL's `#` line-comment syntax.
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const hashIndex = line.indexOf('#');
      return hashIndex === -1 ? line : line.slice(0, hashIndex);
    })
    .join('\n');
}

/**
 * A parsed call: its stable invocation name (used as the node id and as the
 * reference target other calls point at) plus the raw text of everything that
 * follows the call header, from which input references are extracted.
 */
interface ParsedCall {
  /** Invocation name: the `as` alias if present, else the task name segment. */
  invocationName: string;
  /** Display name for the node; same as {@link invocationName}. */
  name: string;
  /** Raw body text of the call block (its input assignments), for scanning. */
  body: string;
}

/**
 * Matches a WDL `call` statement header and captures the fully-qualified task
 * name and an optional `as <alias>`. Examples matched:
 *   `call foo`
 *   `call foo as bar`
 *   `call lib.foo as bar {`
 */
const CALL_HEADER = /\bcall\s+([A-Za-z_][\w.]*)\s*(?:as\s+([A-Za-z_]\w*))?/g;

/**
 * Extract every `call` in the workflow, in source order.
 *
 * For each call we also capture its "body": the brace-delimited block following
 * the header when present (`call foo { input: ... }`), otherwise the remainder
 * of that logical line. The body is where `producer.output` input references
 * live.
 */
function extractCalls(source: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  CALL_HEADER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL_HEADER.exec(source)) !== null) {
    const taskName = match[1];
    const alias = match[2];
    // Invocation name is the alias, or the final dotted segment of the task
    // name (e.g. `lib.foo` -> `foo`).
    const invocationName = alias ?? taskName.split('.').pop() ?? taskName;

    const afterHeader = source.slice(CALL_HEADER.lastIndex);
    const body = extractCallBody(afterHeader);

    calls.push({ invocationName, name: invocationName, body });
  }
  return calls;
}

/**
 * Given the text immediately after a call header, return the call's body: the
 * contents of its `{ ... }` block if one starts here, otherwise the rest of the
 * current line. Brace matching is depth-aware so nested braces don't truncate.
 */
function extractCallBody(afterHeader: string): string {
  // Find the first non-whitespace char; a `{` opens a block body.
  const leading = afterHeader.match(/^\s*/)?.[0].length ?? 0;
  if (afterHeader[leading] === '{') {
    let depth = 0;
    for (let i = leading; i < afterHeader.length; i += 1) {
      const ch = afterHeader[i];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return afterHeader.slice(leading + 1, i);
        }
      }
    }
    // Unbalanced braces: take what we have.
    return afterHeader.slice(leading + 1);
  }
  // No block body; the body is the remainder of this line.
  const newline = afterHeader.indexOf('\n');
  return newline === -1 ? afterHeader : afterHeader.slice(0, newline);
}

/**
 * Collect the set of `<name>.<output>` reference prefixes appearing in a call
 * body — i.e. the invocation names this call reads outputs from. Only the name
 * before the first dot is captured (`fastqc.trimmed` -> `fastqc`).
 */
const REFERENCE = /\b([A-Za-z_]\w*)\.[A-Za-z_]\w*/g;

function referencedNames(body: string): Set<string> {
  const names = new Set<string>();
  REFERENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE.exec(body)) !== null) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Parse a WDL definition into a {@link StaticGraph}.
 *
 * Throws {@link ParseError} identifying the `workflowId` when the definition
 * contains no `call` statements (nothing to graph) or when the derived
 * dependency edges form a cycle. Graph well-formedness is additionally enforced
 * by the dispatcher via `assertValidGraph` (Req 6.4).
 */
function parseWdl(def: WorkflowDefinition): StaticGraph {
  const source = stripComments(readMain(def));
  const calls = extractCalls(source);

  if (calls.length === 0) {
    throw new ParseError(
      def.workflowId,
      'WDL definition contains no call statements',
    );
  }

  // One node per call. Duplicate invocation names would collide as node ids;
  // reject them since edges are keyed by invocation name (Req 6.3).
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.invocationName)) {
      throw new ParseError(
        def.workflowId,
        `duplicate call name "${call.invocationName}"`,
      );
    }
    seen.add(call.invocationName);
    nodes.push({ id: call.invocationName, name: call.name });
  }

  // For each call, every referenced invocation name that is itself a call
  // becomes a producer → consumer edge. De-duplicate identical edges.
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const consumer of calls) {
    for (const producerName of referencedNames(consumer.body)) {
      if (!seen.has(producerName)) {
        continue; // reference to a non-call (e.g. a workflow input); ignore.
      }
      if (producerName === consumer.invocationName) {
        continue; // a call referencing itself is not a dependency edge.
      }
      const key = `${producerName}\u0000${consumer.invocationName}`;
      if (edgeKeys.has(key)) {
        continue;
      }
      edgeKeys.add(key);
      edges.push({ from: producerName, to: consumer.invocationName });
    }
  }

  // WDL edges are derived directly from explicit `name.output` references, so
  // the produced graph is authoritative (Req 4.6; task 4.1 confirms this).
  return { workflowId: def.workflowId, nodes, edges, fidelity: 'exact' };
}

/**
 * The single WDL {@link DefinitionParser} implementation (Req 6.12).
 */
export const wdlParser: DefinitionParser = {
  language: LANGUAGE,
  canParse: (def: WorkflowDefinition): boolean => def.language === LANGUAGE,
  parse: parseWdl,
};

/**
 * Register the WDL parser with the shared registry so {@link parseDefinition}
 * dispatches WDL definitions here. Idempotent: importing this module more than
 * once (or alongside test setup that re-imports it) does not throw, because the
 * registry rejects duplicate registrations and we guard on the existing entry.
 */
export function registerWdlParser(): void {
  if (getParser(LANGUAGE) === undefined) {
    registerParser(wdlParser);
  }
}

// Module-level side effect: registering on import wires the parser into the
// dispatcher, consistent with how sibling language parsers (tasks 6.3/6.4) are
// expected to self-register.
registerWdlParser();
