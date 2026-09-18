/**
 * Custom React Flow node for the run detail DAG.
 *
 * Renders the status-colored, rounded task box with:
 *  - an explicit hover tooltip carrying the full task name (so a name truncated
 *    to an ellipsis inside the box is still readable on hover). A native `title`
 *    is unreliable on React Flow nodes because the connection `Handle`s overlay
 *    the box and intercept the pointer, so we render our own tooltip driven by
 *    hover state instead,
 *  - single-line ellipsis truncation so long names never overflow the box,
 *  - the slowest-task highlight ring (Req 3.6), colored via SLOWEST_TASK_COLOR,
 *  - an amber selection ring marking the node whose logs panel is open,
 *  - node-search emphasis (`searchMatch`) and dimming (`dimmed`) applied by the
 *    run detail view when a search query is active.
 *
 * Handles are rendered for the True_DAG's dependency edges; the Inferred_DAG
 * hides them via the `.task-graph-no-edges` CSS rule (unchanged).
 */
import { useState } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import {
  TASK_NODE_HEIGHT,
  TASK_NODE_WIDTH,
  type TaskNodeData,
} from './graphLayout';
import { SLOWEST_TASK_COLOR } from '../fleet/statusColors';

// Softer, more layered resting shadow than a single hard drop — reads as gently
// elevated rather than stamped-on.
const BASE_SHADOW =
  '0 1px 2px rgba(15, 23, 42, 0.12), 0 4px 10px rgba(15, 23, 42, 0.10)';
// Slightly stronger elevation applied on hover, paired with a small lift.
const HOVER_SHADOW =
  '0 2px 4px rgba(15, 23, 42, 0.16), 0 8px 18px rgba(15, 23, 42, 0.18)';
const HIGHLIGHT_GLOW = `0 0 0 3px ${SLOWEST_TASK_COLOR}73`; // ~45% alpha
// A blue ring for a search match, layered like the slowest-task ring.
const SEARCH_GLOW = '0 0 0 3px rgba(37, 99, 235, 0.65)';
// An amber ring marking the currently selected node (its logs panel is open).
const SELECTED_COLOR = '#f59e0b';
const SELECTED_GLOW = '0 0 0 3px rgba(245, 158, 11, 0.55)';

// A thin translucent inset edge (top light, bottom dark) that gives every box a
// subtle bevel and keeps the border legible across all status fills — the old
// solid-white border washed out on lighter colors (e.g. STARTING #38bdf8).
const INSET_EDGE =
  'inset 0 1px 0 rgba(255, 255, 255, 0.25), inset 0 -1px 0 rgba(15, 23, 42, 0.18)';

/**
 * Build a subtle top-lighter / bottom-darker vertical gradient from the solid
 * status `color`, giving the box depth without altering its status meaning. The
 * gradient is a fixed pair of translucent white/black overlays layered over the
 * base color, so it works for any status color and never changes the hue.
 */
function fillGradient(color: string): string {
  return (
    `linear-gradient(180deg, ` +
    `rgba(255, 255, 255, 0.14) 0%, ` +
    `rgba(255, 255, 255, 0) 45%, ` +
    `rgba(15, 23, 42, 0.14) 100%), ${color}`
  );
}

export default function TaskNode({
  data,
}: NodeProps<TaskNodeData>): React.JSX.Element {
  const { label, color, matched, highlighted, searchMatch, dimmed, selected } =
    data;
  const [hovered, setHovered] = useState(false);

  const border = selected
    ? `2px solid ${SELECTED_COLOR}`
    : highlighted
      ? `2px solid ${SLOWEST_TASK_COLOR}`
      : searchMatch
        ? '2px solid #2563eb'
        : matched
          ? '1px solid rgba(255, 255, 255, 0.7)'
          : '1px dashed rgba(255, 255, 255, 0.75)';

  // Resting elevation lifts to HOVER_SHADOW on hover; the state-ring glows
  // (selected/highlighted/search) always take precedence and pair with the
  // current elevation. INSET_EDGE is layered on every variant for the bevel.
  const elevation = hovered ? HOVER_SHADOW : BASE_SHADOW;
  const shadow = selected
    ? `${elevation}, ${SELECTED_GLOW}, ${INSET_EDGE}`
    : highlighted
      ? `${elevation}, ${HIGHLIGHT_GLOW}, ${INSET_EDGE}`
      : searchMatch
        ? `${elevation}, ${SEARCH_GLOW}, ${INSET_EDGE}`
        : `${elevation}, ${INSET_EDGE}`;

  return (
    <div
      data-testid="task-node"
      data-search-match={searchMatch ? 'true' : 'false'}
      data-dimmed={dimmed ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        width: TASK_NODE_WIDTH,
        height: TASK_NODE_HEIGHT,
        // Lift the hovered node (and its tooltip) above sibling nodes.
        zIndex: hovered ? 10 : undefined,
      }}
    >
      {/* Full-name tooltip on hover. Rendered above the box, unclipped, and at
          full opacity even when the node is dimmed by an active search. */}
      {hovered && (
        <div
          data-testid="task-node-tooltip"
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '6px',
            padding: '4px 8px',
            background: 'rgba(15, 23, 42, 0.95)',
            color: '#ffffff',
            fontSize: '11px',
            fontWeight: 500,
            lineHeight: 1.3,
            borderRadius: '6px',
            whiteSpace: 'nowrap',
            maxWidth: '360px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            boxShadow: '0 2px 8px rgba(15, 23, 42, 0.35)',
            pointerEvents: 'none',
            zIndex: 20,
          }}
        >
          {label}
        </div>
      )}

      <div
        style={{
          background: fillGradient(color),
          color: '#ffffff',
          border,
          boxShadow: shadow,
          borderRadius: '10px',
          padding: '0 10px',
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.02em',
          lineHeight: `${TASK_NODE_HEIGHT - 2}px`,
          display: 'block',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textShadow: '0 1px 1px rgba(15, 23, 42, 0.35)',
          cursor: 'pointer',
          // Slight lift + brighten on hover so the (clickable) box feels
          // interactive; the raised shadow is applied via `shadow` above.
          transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
          filter: hovered ? 'brightness(1.06)' : 'none',
          // Dim non-matching nodes while a search is active so matches stand
          // out; matches (and the normal, no-search state) render at full
          // opacity.
          opacity: dimmed ? 0.25 : 1,
          transition:
            'opacity 120ms ease-in-out, transform 120ms ease-in-out, ' +
            'box-shadow 120ms ease-in-out, filter 120ms ease-in-out',
        }}
      >
        {label}
      </div>

      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
