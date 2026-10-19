/**
 * render.mjs — pure, aligned-table string builders for terminal output.
 *
 * Powers Req 9.3 (clean, aligned, scannable tables) and 9.4 (a visible
 * running summary). Every unavailable value renders as `—` (em dash), NEVER
 * `0` or a blank cell (Req 5.1, 5.2, 5.4). `renderEstimate` always includes
 * the full `ESTIMATE_DISCLAIMER` — imported, not restated — so there is
 * exactly one copy of that wording (see `estimationCore.mjs`).
 */
import { ESTIMATE_DISCLAIMER } from './estimationCore.mjs';

const UNAVAILABLE = '—';

/** Pad every row in `rows` (array of string arrays) to aligned columns. */
function renderAlignedTable(headers, rows) {
  const columnCount = headers.length;
  const widths = Array.from({ length: columnCount }, (_, col) => {
    const headerWidth = headers[col].length;
    const cellWidths = rows.map((row) => String(row[col]).length);
    return Math.max(headerWidth, ...cellWidths, 0);
  });

  const renderRow = (cells) =>
    cells.map((cell, col) => String(cell).padEnd(widths[col])).join('  ');

  const lines = [renderRow(headers)];
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  return lines.join('\n');
}

const fmt = (value) => (value === null || value === undefined ? UNAVAILABLE : String(value));

/**
 * Render the Instance_Option menu as an aligned table: Instance | vCPU |
 * Memory | GPU | Rate/hr, with `—` for any unavailable attribute, plus a
 * trailing legend line.
 *
 * @param {Array<object>} options - `buildInstanceOptions(...)` output.
 * @returns {string}
 */
export function renderInstanceMenu(options) {
  const headers = ['Instance', 'vCPU', 'Memory (GiB)', 'GPU', 'Rate/hr'];
  const rows = options.map((option) => [
    option.instanceType,
    fmt(option.vcpus),
    fmt(option.memoryGiB),
    option.gpuCount ? `${option.gpuCount}x (${option.gpuMemoryGiB} GiB)` : UNAVAILABLE,
    option.rate === null ? UNAVAILABLE : `$${option.rate}`,
  ]);
  const table = renderAlignedTable(headers, rows);
  return `${table}\n\n${UNAVAILABLE} = unavailable`;
}

/**
 * Render a compact recap of the choices made so far in the interactive flow.
 * Reflects every field in `state`, showing "not yet chosen" rather than
 * guessing or omitting unset fields.
 *
 * @param {{steps?: Array<object>, storage?: object|null}} state
 * @returns {string}
 */
export function renderRunningSummary(state = {}) {
  const { steps = [], storage = null } = state;
  const lines = ['Running summary:'];

  if (steps.length === 0) {
    lines.push('  Steps: none defined yet');
  } else {
    lines.push(`  Steps: ${steps.length} defined`);
    steps.forEach((step, index) => {
      lines.push(
        `    ${index + 1}. ${step.label ?? '(unlabeled)'} — ${step.instanceType ?? UNAVAILABLE}, ` +
          `runtime ${step.estimatedRuntimeHours ?? UNAVAILABLE}h/task, scatter ${step.scatterWidth ?? UNAVAILABLE}`,
      );
    });
  }

  if (storage === null) {
    lines.push('  Storage: not yet chosen');
  } else {
    lines.push(
      `  Storage: ${storage.mode} — ${storage.sizeGiB} GiB over ${storage.runRuntimeHours}h`,
    );
  }

  return lines.join('\n');
}

/**
 * Render the itemized Rough_Estimate: usage/resource | quantity | rate |
 * cost, a TOTAL row, a `PARTIAL` badge iff `result.partial`, Region/Currency/
 * Rate_Retrieval_Date, and the full Estimate_Disclaimer (always present,
 * unconditionally).
 *
 * @param {object} result - the (possibly CLI-merged) `estimate()` result,
 *   optionally carrying `region`/`currency`.
 * @returns {string}
 */
export function renderEstimate(result) {
  const headers = ['Usage', 'Quantity', 'Unit', 'Rate', 'Cost'];
  const rows = result.lineItems.map((item) => {
    const usage = item.kind === 'COMPUTE' ? `Compute (${item.instanceType})` : item.family;
    const quantity = item.kind === 'COMPUTE' ? item.instanceHours : item.gbHours;
    return [
      usage,
      quantity === null ? UNAVAILABLE : quantity.toFixed(4),
      item.unit ?? UNAVAILABLE,
      item.rate === null ? UNAVAILABLE : `$${item.rate}`,
      item.cost === null ? UNAVAILABLE : `$${item.cost.toFixed(4)}`,
    ];
  });

  const lines = [renderAlignedTable(headers, rows)];
  lines.push('');
  lines.push(`TOTAL: $${result.total.toFixed(4)}`);
  if (result.partial) {
    lines.push('** PARTIAL — one or more line items could not be priced; total is incomplete **');
  }
  lines.push('');
  lines.push(`Region: ${fmt(result.region)}`);
  lines.push(`Currency: ${fmt(result.currency)}`);
  lines.push(`Rate retrieved: ${fmt(result.retrievedAt)}`);
  lines.push('');
  lines.push(ESTIMATE_DISCLAIMER);

  return lines.join('\n');
}
