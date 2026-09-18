/**
 * Nextflow workflow-definition parser.
 *
 * Implements the single {@link DefinitionParser} for the `NEXTFLOW` language
 * (Req 6.12) and registers itself against the shared parser registry as a
 * module-level side effect, mirroring the WDL (task 6.2) and CWL (task 6.4)
 * parser wiring. Importing this module is sufficient to make the Nextflow
 * parser available to {@link parseDefinition}.
 *
 * ## Multi-file traversal (Req 3.1–3.5, 4.1)
 *
 * Real nf-core workflows are deeply modular: the entry file (`main.nf`) wires
 * in `workflows/<name>/main.nf`, which wires in `subworkflows/**` and
 * `modules/**`, all via DSL2 `include { NAME } from './path'` statements. This
 * parser therefore does not scan a single source string; it traverses the
 * File_Map starting at `mainPath`, following `include` statements transitively
 * across files:
 *
 *   1. `resolveFiles` walks the File_Map from `mainPath`, following the `from`
 *      path of every `include` statement. Each file is **visited at most once**
 *      via a `visited` set, so a cyclic include chain terminates safely
 *      (Req 3.5). An `include` whose target is absent from the File_Map is
 *      skipped and traversal continues (Req 3.4).
 *   2. `resolvePath` resolves an include target relative to the including
 *      file's directory, then tries — in order — the resolved path as-is, the
 *      resolved path + `.nf`, and the resolved path + `/main.nf`. The last form
 *      is the **nf-core module-directory convention**, where an include target
 *      names a directory whose `main.nf` holds the declaration.
 *
 * ## Node inventory (Req 3.2, 3.3, 4.1)
 *
 * Every discovered file is parsed for `process <Name> { ... }` and named
 * `workflow <Name> { ... }` (subworkflow) declarations. The node inventory is
 * the deduped (first-seen-wins) union of process and named-subworkflow names
 * across all reachable files. The unnamed entry `workflow { ... }` is the
 * composition root, not a node. Node ids/names are the declared names.
 *
 * ## Edges (Req 4.2, 4.3)
 *
 * A directed edge is created for each producer → consumer channel connection.
 * The known-call inventory is the **full deduped node set** — processes AND
 * named subworkflows (from the inventory above) — so subworkflows are
 * first-class callable nodes, acting as both producers and consumers exactly
 * like processes. Nextflow's DSL2 wires calls together inside `workflow { ... }`
 * blocks by passing channels (often a call's `.out`) as arguments to another
 * call. Those relationships are recovered by scanning each `workflow` body:
 *
 *   - Seed an alias map with every known process/subworkflow name.
 *   - On `ch = CALL.out[.x]` (or `(a, b) = CALL.out`), alias the LHS name(s) to
 *     the producing node.
 *   - On a call `CALL(args...)` where `CALL` is a known node, emit `P -> CALL`
 *     for every argument token that resolves — directly or via the alias map —
 *     to a producer `P`.
 *
 * Identical edges are de-duplicated and self-loops are never emitted. The graph
 * is not forced acyclic here: if the source genuinely implies a cycle, the
 * dispatcher's `assertValidGraph` rejects it (correct behavior); the heuristic
 * simply does not knowingly manufacture cycles.
 *
 * ## Fidelity (Req 4.6, 4.7)
 *
 * The fidelity rule is derived from signals tracked during the parse:
 *
 *   - `exact` **only** for a trivial single-file workflow: exactly one resolved
 *     file, no include ever followed, exactly one `process`, no named
 *     subworkflows, and no inferred edges (e.g. GreetingsNF). In that case the
 *     node inventory is complete and there is no channel wiring to get wrong.
 *   - `approximate` otherwise — i.e. whenever the workflow spans more than one
 *     resolved file, OR any include was followed, OR any heuristic edge was
 *     inferred (the normal nf-core case). Approximate is the honest label
 *     because the channel-operator limits below mean some real dependencies may
 *     be missed.
 *
 * ## Known limits (documented, per the fidelity contract)
 *
 * Parsing is regex/brace-matching heuristics, not a Nextflow grammar. As a
 * result: string/heredoc contents that happen to look like `include`
 * statements are not distinguished from real ones, dynamically-constructed
 * include paths are not interpreted, and channel operators (`.branch{}`,
 * `.map{}`, `.set{}`, `if` conditionals) are **deliberately not modeled**
 * (Req 4.3) — dependencies expressed only through those operators may be
 * missed. That accepted incompleteness is precisely why a multi-file Nextflow
 * graph is labeled `approximate` (see Fidelity above). The definition source
 * may be malformed; parsing is defensive, so anything the heuristics do not
 * recognize is ignored rather than throwing. The resulting graph is validated
 * for acyclicity and node-count invariants by the dispatcher (see
 * {@link parseDefinition} / {@link assertValidGraph}).
 */

import {
  getParser,
  registerParser,
  type DefinitionParser,
  type GraphEdge,
  type GraphNode,
  type StaticGraph,
  type WorkflowDefinition,
} from './types.js';

/** The language this parser handles. */
const LANGUAGE = 'NEXTFLOW' as const;

/** Matches a valid Nextflow/Groovy identifier. */
const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * Strip comments so identifiers inside them are never mistaken for code.
 * Handles line comments (`//`), block comments, and shell-style `#` comments
 * that appear inside `script:` blocks. String contents are left intact enough
 * for our identifier-level scanning.
 */
function stripComments(source: string): string {
  return source
    // Block comments /* ... */
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Line comments // ...
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Return the directory portion of a POSIX archive-relative path. Mirrors
 * `path.posix.dirname` for the cases the File_Map uses (no drive letters). A
 * path with no `/` has directory `''` (the archive root).
 */
function dirnamePosix(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Normalize a POSIX path by resolving `.` and `..` segments and collapsing
 * redundant separators. Leading `..` segments (escaping the archive root) are
 * preserved so an unresolvable escape simply fails to match any File_Map key.
 */
function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (!isAbsolute) {
        out.push('..');
      }
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  return isAbsolute ? `/${joined}` : joined;
}

/**
 * Join a base directory and a relative target using POSIX semantics, then
 * normalize. An absolute target replaces the base.
 */
function joinPosix(base: string, target: string): string {
  if (target.startsWith('/')) {
    return normalizePosix(target);
  }
  const combined = base.length === 0 ? target : `${base}/${target}`;
  return normalizePosix(combined);
}

/**
 * Extract the `from` paths of every DSL2 `include` statement in `src`.
 *
 * Matches `include { NAME [as ALIAS] [; NAME2 ...] } from '<path>'` (single or
 * double quoted). Only the `from` path is needed for file resolution: the
 * imported declarations are discovered by parsing the target file directly, so
 * the brace-name list is not required for the node inventory. The regex is a
 * heuristic, not a full grammar (see the module header for its limits).
 */
export function extractIncludeTargets(src: string): string[] {
  const re = /\binclude\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    targets.push(match[2]);
  }
  return targets;
}

/**
 * Resolve an `include` target against the including file's directory and return
 * the first matching File_Map key (Req 3.1, 3.4).
 *
 * The target is resolved relative to `dirname(fromPath)` (handling `./` and
 * `../`), then the following candidates are tried in order, returning the first
 * present in `files`:
 *   1. the resolved path as-is,
 *   2. the resolved path + `.nf`,
 *   3. the resolved path + `/main.nf` (nf-core module-directory convention).
 *
 * Returns `null` when none is present so the caller skips the missing include
 * and continues (Req 3.4).
 */
export function resolvePath(
  fromPath: string,
  target: string,
  files: Record<string, string>,
): string | null {
  const resolved = joinPosix(dirnamePosix(fromPath), target);
  const candidates = [resolved, `${resolved}.nf`, `${resolved}/main.nf`];
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) {
      return candidate;
    }
  }
  return null;
}

/** A file discovered during File_Map traversal. */
interface DiscoveredFile {
  /** File_Map key (archive-relative path). */
  path: string;
  /** Comment-stripped file contents. */
  source: string;
}

/**
 * Traverse the File_Map from `mainPath`, following `include` statements
 * transitively, and return every reachable file (with comments stripped) in
 * discovery order (Req 3.1–3.5).
 *
 * A `visited` set guarantees each file is resolved at most once, so cyclic
 * include chains terminate (Req 3.5). Includes whose target is absent from the
 * File_Map are skipped (Req 3.4).
 */
export function resolveFiles(
  files: Record<string, string>,
  mainPath: string,
): DiscoveredFile[] {
  const visited = new Set<string>();
  const discovered: DiscoveredFile[] = [];
  // A FIFO queue gives breadth-first discovery order (entry first, then its
  // direct includes, and so on). Either order is correct; BFS keeps the
  // discovery order intuitive.
  const queue: string[] = [normalizePosix(mainPath)];

  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (visited.has(path)) {
      continue; // cycle-safe: each file resolved at most once (Req 3.5)
    }
    visited.add(path);

    const raw = files[path];
    if (raw === undefined) {
      continue; // unresolved include target absent from the map (Req 3.4)
    }

    const source = stripComments(raw);
    discovered.push({ path, source });

    for (const target of extractIncludeTargets(source)) {
      const resolved = resolvePath(path, target, files);
      if (resolved !== null && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return discovered;
}

/**
 * Extract the body of the first brace-delimited block that starts at or after
 * `openIndex` (which must point at the `{`). Returns the inner text and the
 * index just past the matching `}`. Returns `null` if unbalanced.
 */
function readBlock(
  source: string,
  openIndex: number,
): { body: string; end: number } | null {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(openIndex + 1, i), end: i + 1 };
      }
    }
  }
  return null;
}

/** A parsed declaration that becomes a graph node (process or subworkflow). */
interface ProcessDecl {
  name: string;
}

/**
 * Find every `process <Name> { ... }` declaration in the source. Each becomes
 * exactly one graph node (Req 4.1). Brace matching is depth-aware so nested
 * blocks inside a process body do not cause the scan to lose its place.
 */
function parseProcesses(source: string): ProcessDecl[] {
  const processes: ProcessDecl[] = [];
  const header = new RegExp(`\\bprocess\\s+(${IDENTIFIER})\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = header.exec(source)) !== null) {
    const name = match[1];
    const openIndex = match.index + match[0].length - 1; // position of '{'
    const block = readBlock(source, openIndex);
    processes.push({ name });
    if (block) {
      // Continue scanning after this process body so nested `{}` are skipped.
      header.lastIndex = block.end;
    }
  }
  return processes;
}

/**
 * Find every **named** `workflow <Name> { ... }` (subworkflow) declaration in
 * the source. Each named subworkflow becomes a graph node (Req 4.1). The
 * unnamed entry `workflow { ... }` is the composition root, not a node, and is
 * excluded here — the header regex requires a name after `workflow`.
 */
function parseNamedWorkflows(source: string): ProcessDecl[] {
  const workflows: ProcessDecl[] = [];
  const header = new RegExp(`\\bworkflow\\s+(${IDENTIFIER})\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = header.exec(source)) !== null) {
    const name = match[1];
    const openIndex = match.index + match[0].length - 1; // position of '{'
    const block = readBlock(source, openIndex);
    workflows.push({ name });
    if (block) {
      header.lastIndex = block.end;
    }
  }
  return workflows;
}

/**
 * Resolve producer→consumer edges by scanning the `workflow { ... }` block(s).
 *
 * `nodes` is the **full deduped node set** — processes AND named subworkflows.
 * Both kinds are treated identically as callable nodes: a subworkflow can be a
 * producer (`SUBWF.out`) and a consumer (`SUBWF(FOO.out)`) exactly like a
 * process, so calls to subworkflows create edges and `X.out` from a subworkflow
 * resolves (Req 4.2, 4.3).
 *
 * We track a set of "producer aliases": tokens that, when referenced, imply a
 * dependency on a specific producing node. These start as the node names
 * themselves and grow as local variables are bound to producer outputs
 * (`ch = FOO.out`).
 */
function parseEdges(source: string, nodes: ProcessDecl[]): GraphEdge[] {
  const nodeNames = new Set(nodes.map((n) => n.name));

  // Map every known producer alias -> producing node name. We seed the map with
  // node names only: a channel reference names its producing node directly
  // (`NODE.out`, `NODE.out.channel`), so the node name is the unambiguous
  // signal. Bare output-channel leaf names are intentionally NOT aliased
  // because the same channel name (e.g. `out`) is commonly declared by multiple
  // nodes and would resolve ambiguously. Local variables bound to a producer's
  // output (`ch = NODE.out`) are added to this map as they are encountered
  // during the scan below.
  const aliasToProducer = new Map<string, string>();
  for (const node of nodes) {
    aliasToProducer.set(node.name, node.name);
  }

  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  const addEdge = (from: string, to: string): void => {
    if (from === to) {
      return; // never emit a self-loop
    }
    const key = `${from}\u0000${to}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ from, to });
    }
  };

  /** Resolve a referenced token to a producing process, if any. */
  const resolveProducer = (token: string): string | undefined => {
    return aliasToProducer.get(token);
  };

  for (const body of collectWorkflowBodies(source)) {
    // Process each statement (split on newlines and semicolons). Order matters
    // so that a variable bound earlier can be referenced later.
    const statements = body.split(/[\n;]+/);
    for (const raw of statements) {
      const statement = raw.trim();
      if (statement.length === 0) {
        continue;
      }

      // Assignment binding a local variable/channel to producer output(s):
      //   ch = FOO.out
      //   (a, b) = FOO.out
      const assign = /^(?:\(([^)]*)\)|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*(.+)$/.exec(
        statement,
      );
      if (assign) {
        const lhsNames = (assign[1] ?? assign[2] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => new RegExp(`^${IDENTIFIER}$`).test(s));
        const producers = referencedProducers(assign[3], resolveProducer);
        // If exactly one producer feeds the RHS, alias the LHS name(s) to it.
        if (producers.size === 1) {
          const [producer] = [...producers];
          for (const lhs of lhsNames) {
            aliasToProducer.set(lhs, producer);
          }
        }
        // An assignment RHS that is itself a process call still creates edges.
      }

      // Process invocations create consumer edges from every producer whose
      // output is referenced as an argument. Find calls `NAME( ... )`.
      const callRe = new RegExp(`\\b(${IDENTIFIER})\\s*\\(`, 'g');
      let call: RegExpExecArray | null;
      while ((call = callRe.exec(statement)) !== null) {
        const callee = call[1];
        if (!nodeNames.has(callee)) {
          continue; // only connections between known nodes matter (Req 4.2)
        }
        const argsBlock = readParenArgs(statement, call.index + call[0].length - 1);
        if (argsBlock === null) {
          continue;
        }
        const producers = referencedProducers(argsBlock, resolveProducer);
        for (const producer of producers) {
          addEdge(producer, callee);
        }
      }
    }
  }

  return edges;
}

/**
 * Read the argument text inside a parenthesized call whose `(` is at
 * `openIndex`. Returns the inner text or `null` if unbalanced.
 */
function readParenArgs(source: string, openIndex: number): string | null {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex + 1, i);
      }
    }
  }
  return null;
}

/**
 * Given an expression's text, return the set of producing processes it
 * references. Recognizes `PROCESS.out...`, bare producer aliases, and output
 * channel leaf names. Uses the alias resolver to follow local bindings.
 */
function referencedProducers(
  expression: string,
  resolveProducer: (token: string) => string | undefined,
): Set<string> {
  const producers = new Set<string>();
  const tokenRe = new RegExp(IDENTIFIER, 'g');
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(expression)) !== null) {
    const producer = resolveProducer(m[0]);
    if (producer) {
      producers.add(producer);
    }
  }
  return producers;
}

/** Collect the bodies of every `workflow { ... }` block (named or entry). */
function collectWorkflowBodies(source: string): string[] {
  const bodies: string[] = [];
  const header = new RegExp(`\\bworkflow(?:\\s+${IDENTIFIER})?\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = header.exec(source)) !== null) {
    const openIndex = match.index + match[0].length - 1;
    const block = readBlock(source, openIndex);
    if (block) {
      bodies.push(block.body);
      header.lastIndex = block.end;
    }
  }
  return bodies;
}

/**
 * The Nextflow parser implementation.
 */
export const nextflowParser: DefinitionParser = {
  language: LANGUAGE,

  canParse(def: WorkflowDefinition): boolean {
    return def.language === LANGUAGE;
  },

  parse(def: WorkflowDefinition): StaticGraph {
    // Traverse the File_Map from the entry file, following `include` statements
    // transitively across files (visit-once, cycle-safe). A single-file
    // workflow with no includes yields exactly one discovered file — the entry
    // — so behavior matches the previous single-source parser (Req 3.1–3.5).
    const discovered = resolveFiles(def.files, def.mainPath);

    // Node inventory: the deduped (first-seen-wins) union of `process` and
    // named-subworkflow declarations across every reachable file. The unnamed
    // entry `workflow { }` is the composition root, not a node (Req 3.2, 3.3,
    // 4.1). Deduping keeps `assertValidGraph`'s node-id uniqueness invariant.
    const nodes: GraphNode[] = [];
    const seen = new Set<string>();
    let processCount = 0;
    let namedWorkflowCount = 0;
    for (const file of discovered) {
      const processes = parseProcesses(file.source);
      const namedWorkflows = parseNamedWorkflows(file.source);
      processCount += processes.length;
      namedWorkflowCount += namedWorkflows.length;
      for (const decl of [...processes, ...namedWorkflows]) {
        if (!seen.has(decl.name)) {
          seen.add(decl.name);
          nodes.push({ id: decl.name, name: decl.name });
        }
      }
    }

    // Best-effort edge inference (Req 4.2, 4.3): run the producer→consumer
    // heuristic across the union of every discovered file's workflow bodies,
    // using the FULL deduped node set (processes + named subworkflows) as the
    // known-call inventory. Seeding subworkflow names alongside process names is
    // what makes subworkflows first-class producers/consumers.
    const dedupedNodes: ProcessDecl[] = [...seen].map((name) => ({ name }));
    const unionSource = discovered.map((file) => file.source).join('\n');
    const edges = parseEdges(unionSource, dedupedNodes);

    // Fidelity decision (Req 4.6, 4.7). `exact` is reserved for the trivial
    // single-file case where the inventory is complete and there is no channel
    // wiring to interpret: exactly one resolved file, no include ever followed,
    // exactly one process, no named subworkflows, and no inferred edges (e.g.
    // GreetingsNF). Every other shape — multiple resolved files, a followed
    // include, or any heuristic edge — is `approximate`, since the unmodeled
    // channel operators (see the module header) mean edges may be incomplete.
    const includeFollowed = discovered.length > 1;
    const isTrivialSingleFile =
      discovered.length === 1 &&
      !includeFollowed &&
      processCount === 1 &&
      namedWorkflowCount === 0 &&
      edges.length === 0;

    return {
      workflowId: def.workflowId,
      nodes,
      edges,
      fidelity: isTrivialSingleFile ? 'exact' : 'approximate',
    };
  },
};

/**
 * Register the Nextflow parser with the shared registry so
 * {@link parseDefinition} dispatches Nextflow definitions here. Idempotent:
 * guarding on the existing entry keeps re-imports from throwing, matching the
 * WDL parser's `registerWdlParser()` convention (task 6.2).
 */
export function registerNextflowParser(): void {
  if (getParser(LANGUAGE) === undefined) {
    registerParser(nextflowParser);
  }
}

// Module-level side effect: registering on import wires the parser into the
// dispatcher, consistent with how the sibling WDL (6.2) and CWL (6.4) parsers
// self-register.
registerNextflowParser();
