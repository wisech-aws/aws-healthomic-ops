/**
 * Reusable nf-core-style Nextflow definition fixture (spec task 5.3).
 *
 * This module exports a realistic-but-minimal multi-file Nextflow File_Map that
 * models the real nf-core layering:
 *
 *   main.nf
 *     -> workflows/demo/main.nf                        (named `workflow DEMO`)
 *          -> subworkflows/local/input_check/main.nf   (named `workflow INPUT_CHECK`)
 *               -> modules/local/samplesheet_check/main.nf   (process SAMPLESHEET_CHECK)
 *          -> modules/local/fastqc/main.nf             (process FASTQC)
 *          -> modules/local/multiqc/main.nf            (process MULTIQC)
 *
 * Files are wired by DSL2 `include { NAME } from './path'` statements. At least
 * one include uses the nf-core **module-directory** convention (a `from` path
 * with no `.nf` extension that resolves to `<path>/main.nf`), exercising the
 * `resolvePath` `/main.nf` candidate.
 *
 * The dataflow backbone is deliberately LINEAR and simple so the task-5.2
 * best-effort heuristic actually infers the producer -> consumer edges:
 *
 *   INPUT_CHECK.out        -> FASTQC(...)
 *   FASTQC.out             -> MULTIQC(...)
 *   SAMPLESHEET_CHECK.out  -> (inside INPUT_CHECK, emitted as INPUT_CHECK's out)
 *
 * The constants below (`NFCORE_EXPECTED_NODES`, `NFCORE_EXPECTED_EDGES`) reflect
 * the parser's ACTUAL honest output and were verified against
 * `nextflowParser.parse(...)` — see `nextflow.test.ts` self-check. They are NOT
 * aspirational: only edges the linear `X.out -> Z(...)` backbone yields are
 * listed.
 *
 * See {@link NFCORE_BRANCHY_NOTE} for a dependency deliberately expressed via a
 * channel operator (`.map{}`) that the heuristic does NOT model and therefore
 * is NOT an expected edge (usable by task 5.6's "may be absent" assertion).
 */

/** Entry point path within the File_Map. */
export const NFCORE_MAIN_PATH = 'main.nf';

/**
 * The nf-core-style File_Map. Process bodies carry realistic `input:` /
 * `output:` / `script:` blocks with `emit:` names, kept minimal.
 */
export const NFCORE_FILES: Record<string, string> = {
  // Entry: wires in the top-level named workflow via a module-directory include
  // (`./workflows/demo` -> `workflows/demo/main.nf`).
  'main.nf': `
nextflow.enable.dsl = 2

include { DEMO } from './workflows/demo'

workflow {
  DEMO()
}
`,

  // Top-level named workflow. Includes the input-check subworkflow (directory
  // convention) plus two process modules, and wires them into a linear
  // INPUT_CHECK -> FASTQC -> MULTIQC backbone.
  'workflows/demo/main.nf': `
include { INPUT_CHECK } from '../../subworkflows/local/input_check'
include { FASTQC }      from '../../modules/local/fastqc/main.nf'
include { MULTIQC }     from '../../modules/local/multiqc/main.nf'

workflow DEMO {
  INPUT_CHECK()
  FASTQC(INPUT_CHECK.out)
  MULTIQC(FASTQC.out)
}
`,

  // Subworkflow: includes a module (directory convention) and emits its output.
  'subworkflows/local/input_check/main.nf': `
include { SAMPLESHEET_CHECK } from '../../../modules/local/samplesheet_check'

workflow INPUT_CHECK {
  take:
    samplesheet
  main:
    SAMPLESHEET_CHECK(samplesheet)
  emit:
    reads = SAMPLESHEET_CHECK.out.reads
}
`,

  // Module: samplesheet validation process.
  'modules/local/samplesheet_check/main.nf': `
process SAMPLESHEET_CHECK {
  input:
    path samplesheet
  output:
    path 'reads.csv', emit: reads

  script:
  """
  check_samplesheet.py \${samplesheet} reads.csv
  """
}
`,

  // Module: FASTQC process.
  'modules/local/fastqc/main.nf': `
process FASTQC {
  input:
    path reads
  output:
    path '*.zip', emit: zip

  script:
  """
  fastqc \${reads}
  """
}
`,

  // Module: MULTIQC process. Note the dependency on FASTQC arrives via a
  // channel operator (`.map{}`) elsewhere in real pipelines; here MULTIQC is
  // fed directly from DEMO so the edge IS expected. See NFCORE_BRANCHY_NOTE for
  // the operator-only case that is intentionally NOT modeled.
  'modules/local/multiqc/main.nf': `
process MULTIQC {
  input:
    path fastqc_zip
  output:
    path 'multiqc_report.html', emit: report

  script:
  """
  multiqc .
  """
}
`,
};

/**
 * Deduped process + named-subworkflow node names the parser yields from
 * {@link NFCORE_FILES}. Sorted for stable comparison. The unnamed entry
 * `workflow { }` in `main.nf` is the composition root, not a node.
 */
export const NFCORE_EXPECTED_NODES: string[] = [
  'DEMO',
  'FASTQC',
  'INPUT_CHECK',
  'MULTIQC',
  'SAMPLESHEET_CHECK',
].sort();

/**
 * Producer -> consumer edges the best-effort heuristic infers from the linear
 * backbone. Sorted (by `from`, then `to`) for order-independent comparison.
 *
 * - `INPUT_CHECK -> FASTQC`   from `FASTQC(INPUT_CHECK.out)` in DEMO
 * - `FASTQC -> MULTIQC`       from `MULTIQC(FASTQC.out)` in DEMO
 * - `SAMPLESHEET_CHECK -> INPUT_CHECK` from `SAMPLESHEET_CHECK(samplesheet)` ...
 *   `emit: SAMPLESHEET_CHECK.out.reads` inside INPUT_CHECK's body (the emit
 *   references SAMPLESHEET_CHECK.out, and INPUT_CHECK's own body is where the
 *   call lives — but the call arg `samplesheet` is a `take:` input, not a
 *   producer, so no SAMPLESHEET_CHECK -> INPUT_CHECK edge is inferred).
 *
 * The verified set is the DEMO-body backbone only; see the self-check test.
 */
export const NFCORE_EXPECTED_EDGES: { from: string; to: string }[] = [
  { from: 'FASTQC', to: 'MULTIQC' },
  { from: 'INPUT_CHECK', to: 'FASTQC' },
].sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

/**
 * Documentation of a dependency expressed only through a channel operator and
 * therefore NOT expected as an edge (usable by task 5.6's "may be absent"
 * assertion). In this fixture, SAMPLESHEET_CHECK's output is consumed inside
 * INPUT_CHECK via an `emit:` re-export rather than a direct producer->consumer
 * call argument at the DEMO level, so no `SAMPLESHEET_CHECK -> *` edge is
 * inferred by the linear-backbone heuristic. Dependencies routed through
 * `.map{}` / `.branch{}` / `.set{}` / `if` are likewise not modeled (Req 4.3).
 */
export const NFCORE_BRANCHY_NOTE =
  'SAMPLESHEET_CHECK feeds INPUT_CHECK.out via an emit re-export, not a direct ' +
  'call argument, so no SAMPLESHEET_CHECK->consumer edge is inferred. Operator-' +
  'routed dependencies (.map/.branch/.set/if) are likewise not modeled (Req 4.3).';
