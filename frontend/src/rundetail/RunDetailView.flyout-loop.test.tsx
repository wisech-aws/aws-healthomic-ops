import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Node } from 'reactflow';
import { Dashboard } from '../App';

/**
 * Regression test for the task-node fly-out render loop (React #185,
 * "Maximum update depth exceeded").
 *
 * This exercises the REAL app shell path that every prior test missed:
 *   Dashboard  →  real SplitPanelSlotContext.Provider  →  RunDetailView
 * i.e. RunDetailView registers its fly-out node into the shell's split-panel
 * slot, which sets STATE on the parent `Dashboard`, which re-renders
 * RunDetailView. If any dependency feeding that slot-registration effect gets a
 * fresh identity every render, the effect re-fires every render and the
 * Dashboard ⇄ RunDetailView pair loops forever the instant a task is selected.
 *
 * The specific bug was `const nowMs = now ?? Date.now()` — with no injected
 * `now` prop (which the real Dashboard never passes), `Date.now()` minted a new
 * value each render, giving `detailPanel` → `flyoutNode` new identities and
 * retriggering the slot effect. The fix memoizes `nowMs`.
 *
 * To make the loop deterministically fail this test if reintroduced:
 *   - We do NOT pass a `now` prop (the real Dashboard doesn't), so the unstable
 *     branch is what runs.
 *   - React logs #185 via console.error before/while throwing, so we spy on
 *     console.error and assert it was never called with the loop message.
 *   - We also assert the fly-out actually opens with the task's log header,
 *     proving the click did open the detail (not merely "no error because
 *     nothing happened").
 *
 * If someone reverts `nowMs` to `now ?? Date.now()`, opening the fly-out drives
 * the Dashboard ⇄ RunDetailView loop, React emits "Maximum update depth
 * exceeded" via console.error, and the console.error assertion fails.
 */

// AppLayout as a pass-through so the shell renders headlessly in jsdom while
// still forwarding the split-panel node when open (mirrors App.test.tsx). The
// loop lives in the slot-registration effect → Dashboard state → re-render
// path, which does NOT need the real Cloudscape AppLayout; it only needs the
// real Dashboard + real SplitPanelSlotContext, both of which are used here.
vi.mock('@cloudscape-design/components/app-layout', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => (
    <div data-testid="app-layout">
      <div data-testid="app-layout-content">
        {props.content as React.ReactNode}
      </div>
      {props.splitPanelOpen ? (
        <div data-testid="app-layout-split-panel">
          {props.splitPanel as React.ReactNode}
        </div>
      ) : null}
    </div>
  ),
}));

// The real Cloudscape SplitPanel requires a real AppLayout context (it throws
// "Split panel can only be used inside app layout" otherwise). Since AppLayout
// is a headless pass-through here, render SplitPanel as a plain wrapper that
// still surfaces its `header` and children. This keeps the fly-out node's
// identity/state flow — the thing the loop lives in — completely real: it is
// still built by RunDetailView's `flyoutNode` useMemo, registered through the
// real SplitPanelSlotContext, and re-rendered via real Dashboard state.
vi.mock('@cloudscape-design/components/split-panel', () => ({
  __esModule: true,
  default: ({
    header,
    children,
  }: {
    header?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div data-testid="split-panel">
      <div data-testid="split-panel-header">{header}</div>
      {children}
    </div>
  ),
}));

// Client mock: one run with one task, so the DAG renders a single clickable
// node whose selection opens the task fly-out.
vi.mock('../api/client', () => ({
  listRuns: vi.fn().mockResolvedValue({
    items: [
      {
        runId: 'run-1',
        status: 'RUNNING',
        name: 'my-run',
        workflowName: 'my-workflow',
        startedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    nextToken: null,
  }),
  getRun: vi.fn().mockResolvedValue({
    runId: 'run-1',
    status: 'RUNNING',
    name: 'my-run',
    startedAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }),
  listTasksForRun: vi.fn().mockResolvedValue([
    {
      runId: 'run-1',
      taskId: 't1',
      name: 'align',
      status: 'RUNNING',
      startedAt: '2024-01-01T00:00:00.000Z',
      stoppedAt: null,
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ]),
  getStaticGraph: vi.fn().mockResolvedValue(null),
  getRunMetrics: vi
    .fn()
    .mockResolvedValue({ runId: 'run-1', window: null, series: [], error: null }),
  getRunCostEstimate: vi.fn().mockResolvedValue({
    runId: 'run-1',
    lineItems: [],
    total: null,
    currency: null,
    effectiveDate: null,
    partial: false,
    error: null,
  }),
  getErrorExcerpt: vi
    .fn()
    .mockResolvedValue({ found: false, lines: [], truncated: false }),
  getRunLogs: vi.fn().mockResolvedValue({
    logStreamName: 'run/run-1/task/t1',
    events: [{ timestamp: 1704067200000, message: 'task log line' }],
    nextToken: null,
  }),
  onRunUpdated: vi.fn(() => ({ unsubscribe: () => {} })),
  onTaskUpdated: vi.fn(() => ({ unsubscribe: () => {} })),
}));

// React Flow rendered headlessly, wiring onNodeClick to a click on each node so
// the test can select the task node exactly as a user would (mirrors
// RunDetailView.test.tsx).
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({
    nodes,
    onNodeClick,
  }: {
    nodes: Node[];
    onNodeClick?: (event: unknown, node: Node) => void;
  }) => (
    <div data-testid="reactflow">
      {nodes.map((n) => (
        <div
          key={n.id}
          data-testid={`node-${n.id}`}
          onClick={() => onNodeClick?.(undefined, n)}
        >
          {(n.data as { label?: string }).label}
        </div>
      ))}
    </div>
  ),
  Handle: () => null,
  useReactFlow: () => ({ fitView: () => {} }),
  Background: () => null,
  BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));
vi.mock('reactflow/dist/style.css', () => ({}));

// Keep Amplify/config out of the way: force real (non-mock) mode so Dashboard
// is exercised directly and configureAmplify is a no-op (mirrors App.test.tsx).
vi.mock('../api/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/config')>();
  return {
    ...actual,
    isLocalMockMode: () => false,
    configureAmplify: vi.fn().mockResolvedValue(undefined),
  };
});

describe('RunDetailView fly-out slot render loop (React #185)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('opens the task fly-out through the real Dashboard shell without an infinite update loop', async () => {
    render(<Dashboard />);

    // Select the seeded run from the fleet to enter the run-detail view.
    const link = await screen.findByRole('link', { name: /view run my-run/i });
    fireEvent.click(link);

    // The DAG renders with the single task node.
    const node = await screen.findByTestId('node-t1');

    // Click the task node — this drives the selection → fly-out slot
    // registration path that, on the un-fixed code, loops forever.
    fireEvent.click(node);

    // The fly-out opens on that task: its Cloudscape SplitPanel header names the
    // selection. This confirms the click actually opened the detail (so a green
    // result can't come from "nothing happened").
    expect(
      (await screen.findAllByText(/logs — task align/i)).length,
    ).toBeGreaterThan(0);

    // The core assertion: React never reported a maximum-update-depth loop.
    // #185 is emitted via console.error; on the un-fixed code the click would
    // produce this and fail the test.
    await waitFor(() => {
      const loopReported = errorSpy.mock.calls.some((args) =>
        args.some(
          (arg) =>
            typeof arg === 'string' &&
            /maximum update depth exceeded/i.test(arg),
        ),
      );
      expect(loopReported).toBe(false);
    });
  });
});
