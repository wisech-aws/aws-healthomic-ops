/**
 * Band-continuation cue node for the Inferred_DAG layout.
 *
 * A PRESENTATIONAL DECORATION — not a task. It renders a single faint `↩`
 * (U+21A9) glyph in the reserved column-8 lane at the right edge of every
 * non-final row of a concurrency band that wraps onto additional rows, so the
 * user can tell the same inferred timing level continues below.
 *
 * Strict no-fabrication: the cue conveys ONLY "this band continues on the next
 * row" — it asserts no dependency or parallelism relationship.
 *
 * It is non-interactive by construction: the container has
 * `pointer-events: none`, renders no React Flow `Handle`s, and the layout marks
 * the node `selectable: false` / `focusable: false` / `draggable: false` /
 * `connectable: false`. It carries no status color, no task-box border, and no
 * `label` (so node search ignores it entirely).
 */
import { type NodeProps } from 'reactflow';
import {
  TASK_NODE_HEIGHT,
  TASK_NODE_WIDTH,
  type BandContinuationNodeData,
} from './graphLayout';

export default function BandContinuationNode({
  data,
}: NodeProps<BandContinuationNodeData>): React.JSX.Element {
  return (
    <div
      data-testid="band-continuation"
      role="img"
      aria-label={data.aria}
      style={{
        width: TASK_NODE_WIDTH,
        height: TASK_NODE_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Borderless, transparent container with no status color and no shadow:
        // the cue reads as a faint decoration subordinate to the task boxes.
        border: 'none',
        background: 'transparent',
        boxShadow: 'none',
        // Faint, muted slate so it is clearly subordinate to task boxes on the
        // light `.task-graph` canvas.
        color: 'rgba(100, 116, 139, 0.55)',
        fontSize: '20px',
        lineHeight: 1,
        userSelect: 'none',
        // Never intercept the pointer — it must not be clickable/selectable.
        pointerEvents: 'none',
      }}
    >
      {/* The glyph itself is decorative; the accessible name lives on the
          role="img" container above. */}
      <span aria-hidden="true">↩</span>
    </div>
  );
}
