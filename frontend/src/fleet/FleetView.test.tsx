import { describe, it, expect, vi } from 'vitest';
import {
  render,
  screen,
  waitFor,
  within,
  fireEvent,
  act,
} from '@testing-library/react';
import FleetView from './FleetView';
import type { FleetViewControls, SubscribeRuns } from './FleetView';
import type { Run, RunConnection } from '../api/types';
import type { Subscription, SubscriptionHandlers } from '../api/client';
import createWrapper from '@cloudscape-design/components/test-utils/dom';

function run(partial: Partial<Run> & { runId: string }): Run {
  return {
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

function connection(items: Run[]): RunConnection {
  return { items, nextToken: null };
}

/**
 * A subscribe stub that captures the handlers so a test can push
 * `onRunUpdated` events synchronously. Returns a no-op unsubscribe.
 */
function makeSubscribe(): {
  subscribe: SubscribeRuns;
  emit: (value: Run) => void;
} {
  let handlers: SubscriptionHandlers<Run> | undefined;
  const subscribe: SubscribeRuns = (h) => {
    handlers = h;
    const sub: Subscription = { unsubscribe: () => {} };
    return sub;
  };
  return {
    subscribe,
    emit: (value: Run) => {
      act(() => {
        handlers?.next(value);
      });
    },
  };
}

/** A subscribe stub that never delivers — for tests that don't exercise live updates. */
const noopSubscribe: SubscribeRuns = () => ({ unsubscribe: () => {} });

/**
 * Resolves the Cloudscape wrapper scoped to a control's stable `data-testid`.
 * The fleet controls render several Selects plus a Multiselect and a Toggle, so
 * a bare `findSelect()` on the whole container is ambiguous; scoping to the
 * testid element picks the intended control. Cloudscape forwards `data-testid`
 * to the component root, and the test-utils finders match descendants, so we
 * wrap the testid element's parent (each control sits alone in its FormField).
 */
function wrapperForTestId(container: HTMLElement, testId: string) {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el?.parentElement) {
    throw new Error(`control with data-testid "${testId}" not found`);
  }
  return createWrapper(el.parentElement);
}

/**
 * Adds a status to the multi-status filter (Req 5.1). The status filter is a
 * Cloudscape Multiselect; selecting an option toggles it into the active set
 * without closing over a single selection. Driven via the official test-utils
 * wrapper because a plain fireEvent does not open Cloudscape dropdowns.
 */
function addStatusFilter(container: HTMLElement, value: string): void {
  const multiselect = wrapperForTestId(
    container,
    'fleet-status-filter',
  ).findMultiselect();
  if (!multiselect) {
    throw new Error('status filter Multiselect not found');
  }
  multiselect.openDropdown();
  multiselect.selectOptionByValue(value);
}

/** Selects a workflow in the workflow-filter Select by its value (workflowId). */
function selectWorkflowFilter(container: HTMLElement, value: string): void {
  const select = wrapperForTestId(
    container,
    'fleet-workflow-filter',
  ).findSelect();
  if (!select) {
    throw new Error('workflow filter Select not found');
  }
  select.openDropdown();
  select.selectOptionByValue(value);
}

/** Selects a sort key ('recency' | 'duration') in the sort-key Select. */
function selectSortKey(container: HTMLElement, value: string): void {
  const select = wrapperForTestId(container, 'fleet-sort-key').findSelect();
  if (!select) {
    throw new Error('sort key Select not found');
  }
  select.openDropdown();
  select.selectOptionByValue(value);
}

/** Toggles the engine-version grouping control on/off. */
function toggleGroupByEngine(container: HTMLElement): void {
  const toggle = wrapperForTestId(container, 'fleet-group-toggle').findToggle();
  if (!toggle) {
    throw new Error('group-by-engine Toggle not found');
  }
  toggle.findNativeInput().click();
}

/** Toggles the batch grouping control on/off. */
function toggleGroupByBatch(container: HTMLElement): void {
  const toggle = wrapperForTestId(
    container,
    'fleet-group-batch-toggle',
  ).findToggle();
  if (!toggle) {
    throw new Error('group-by-batch Toggle not found');
  }
  toggle.findNativeInput().click();
}

/** Reads the workflow-column text of every data row, in render order. */
function workflowColumnText(): (string | null)[] {
  const rows = screen.getAllByRole('row').slice(1); // drop header row
  return rows.map((r) => within(r).getAllByRole('cell')[1].textContent);
}

describe('FleetView', () => {
  it('shows a loading indicator while the query is in flight (Req 10.1)', () => {
    // A never-resolving promise keeps the component in the loading phase.
    const listRuns = vi.fn(() => new Promise<RunConnection>(() => {}));
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);
    expect(screen.getByText(/loading runs/i)).toBeInTheDocument();
  });

  it('queries listRuns exactly once on mount (Req 10.4)', async () => {
    const listRuns = vi.fn().mockResolvedValue(connection([]));
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);
    await waitFor(() =>
      expect(screen.getByText(/no runs are available/i)).toBeInTheDocument(),
    );
    expect(listRuns).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no runs are returned (Req 8.3, 10.3)', async () => {
    const listRuns = vi.fn().mockResolvedValue(connection([]));
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);
    expect(
      await screen.findByText(/no runs are available/i),
    ).toBeInTheDocument();
  });

  it('renders a row per run with status, workflow, start time, duration (Req 8.1)', async () => {
    const listRuns = vi.fn().mockResolvedValue(
      connection([
        run({
          runId: 'r1',
          name: 'nightly-align-run',
          status: 'RUNNING',
          workflowName: 'align-and-call',
          workflowId: 'wf-777',
          startedAt: '2024-01-01T00:00:00.000Z',
          stoppedAt: '2024-01-01T01:00:00.000Z',
          updatedAt: '2024-01-01T02:00:00.000Z',
        }),
      ]),
    );
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);

    const table = await screen.findByRole('table');
    // The workflow name appears in the clickable "Workflow" column.
    expect(within(table).getAllByText('align-and-call').length).toBeGreaterThanOrEqual(1);
    // The dedicated Run name column shows the run's own name (distinct from the
    // workflow name).
    expect(within(table).getByTestId('run-name')).toHaveTextContent(
      'nightly-align-run',
    );
    expect(within(table).getByLabelText(/status RUNNING/i)).toBeInTheDocument();
    expect(within(table).getByText('01:00:00')).toBeInTheDocument();
    // Run ID and Workflow ID columns (Req: show run/workflow identifiers).
    expect(within(table).getByText('r1')).toBeInTheDocument();
    expect(within(table).getByText('wf-777')).toBeInTheDocument();
  });

  it('shows a dash in the Run name column when the run has no name', async () => {
    const listRuns = vi.fn().mockResolvedValue(
      connection([
        run({ runId: 'r1', workflowId: 'wf-999', updatedAt: '2024-01-01T00:00:00.000Z' }),
      ]),
    );
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);
    await screen.findByRole('table');
    expect(screen.getByTestId('run-name')).toHaveTextContent('—');
  });

  it('re-queries listRuns when the refresh button is clicked', async () => {
    const listRuns = vi.fn().mockResolvedValue(
      connection([run({ runId: 'r1', workflowName: 'wf-a' })]),
    );
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);

    await screen.findByRole('table');
    expect(listRuns).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /refresh runs/i }));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
  });

  it('renders rows in descending updatedAt order (Req 8.4)', async () => {
    const listRuns = vi.fn().mockResolvedValue(
      connection([
        run({ runId: 'older', workflowName: 'wf-older', updatedAt: '2024-01-01T00:00:00.000Z' }),
        run({ runId: 'newer', workflowName: 'wf-newer', updatedAt: '2024-01-03T00:00:00.000Z' }),
        run({ runId: 'mid', workflowName: 'wf-mid', updatedAt: '2024-01-02T00:00:00.000Z' }),
      ]),
    );
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);

    await screen.findByRole('table');
    expect(workflowColumnText()).toEqual(['wf-newer', 'wf-mid', 'wf-older']);
  });

  it('shows an error with a retry action, then recovers (Req 8.2, 10.2)', async () => {
    const listRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        connection([run({ runId: 'r1', workflowName: 'recovered-wf' })]),
      );
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(
      (await screen.findAllByText('recovered-wf')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(listRuns).toHaveBeenCalledTimes(2);
  });

  it('updates a displayed run in place on onRunUpdated (Req 8.5)', async () => {
    const listRuns = vi.fn().mockResolvedValue(
      connection([
        run({
          runId: 'r1',
          status: 'RUNNING',
          workflowName: 'wf-1',
          updatedAt: '2024-01-01T00:00:00.000Z',
        }),
      ]),
    );
    const { subscribe, emit } = makeSubscribe();
    render(<FleetView listRuns={listRuns} subscribe={subscribe} />);

    const table = await screen.findByRole('table');
    expect(within(table).getByLabelText(/status RUNNING/i)).toBeInTheDocument();

    emit(
      run({
        runId: 'r1',
        status: 'COMPLETED',
        workflowName: 'wf-1',
        updatedAt: '2024-01-01T03:00:00.000Z',
      }),
    );

    expect(
      within(table).getByLabelText(/status COMPLETED/i),
    ).toBeInTheDocument();
    // Still exactly one row (updated in place, not inserted).
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(1);
  });

  it('inserts an undisplayed run in ordered position on onRunUpdated (Req 8.6)', async () => {
    const listRuns = vi.fn().mockResolvedValue(
      connection([
        run({ runId: 'a', workflowName: 'wf-a', updatedAt: '2024-01-01T00:00:00.000Z' }),
        run({ runId: 'c', workflowName: 'wf-c', updatedAt: '2024-01-03T00:00:00.000Z' }),
      ]),
    );
    const { subscribe, emit } = makeSubscribe();
    render(<FleetView listRuns={listRuns} subscribe={subscribe} />);

    await screen.findByRole('table');

    emit(run({ runId: 'b', workflowName: 'wf-b', updatedAt: '2024-01-02T00:00:00.000Z' }));

    await waitFor(() => {
      expect(workflowColumnText()).toEqual(['wf-c', 'wf-b', 'wf-a']);
    });
  });

  it('shows a per-run loading indicator until the update is applied (Req 8.11)', async () => {
    const listRuns = vi.fn().mockResolvedValue(
      connection([
        run({ runId: 'r1', status: 'RUNNING', workflowName: 'wf-1', updatedAt: '2024-01-01T00:00:00.000Z' }),
      ]),
    );
    let controls: FleetViewControls | undefined;
    render(
      <FleetView
        listRuns={listRuns}
        subscribe={noopSubscribe}
        onReady={(c) => {
          controls = c;
        }}
      />,
    );

    await screen.findByRole('table');
    expect(controls).toBeDefined();

    // An update source flags the run as pending because it cannot apply the
    // update promptly.
    act(() => {
      controls!.markRunPending('r1');
    });
    expect(screen.getByLabelText(/updating run r1/i)).toBeInTheDocument();

    // The row is not removed and the page is not reloaded.
    expect(screen.getAllByText('wf-1').length).toBeGreaterThanOrEqual(1);

    // Once the update arrives it is applied and the indicator clears.
    act(() => {
      controls!.applyRunUpdate(
        run({ runId: 'r1', status: 'COMPLETED', workflowName: 'wf-1', updatedAt: '2024-01-01T03:00:00.000Z' }),
      );
    });
    expect(screen.queryByLabelText(/updating run r1/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/status COMPLETED/i)).toBeInTheDocument();
  });

  // ── Task 15.2: view integration tests for the fleet controls ──────────────

  describe('duration column and stale badge (Req 1.1, 9.1)', () => {
    // A fixed "now" makes duration and staleness deterministic (Req 1.5, 9.2).
    const NOW = Date.parse('2024-01-01T05:00:00.000Z');

    it('renders a duration cell for every run (Req 1.1)', async () => {
      const listRuns = vi.fn().mockResolvedValue(
        connection([
          run({
            runId: 'terminal',
            status: 'COMPLETED',
            workflowName: 'wf-terminal',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T01:30:00.000Z',
            updatedAt: '2024-01-01T01:30:00.000Z',
          }),
          run({
            runId: 'running',
            status: 'RUNNING',
            workflowName: 'wf-running',
            startedAt: '2024-01-01T04:00:00.000Z',
            updatedAt: '2024-01-01T04:59:00.000Z',
          }),
        ]),
      );
      render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />);

      await screen.findByRole('table');
      const durations = screen.getAllByTestId('run-duration');
      expect(durations).toHaveLength(2);
      // Terminal run: fixed start→stop span of 1h30m.
      expect(screen.getByLabelText('duration run terminal')).toHaveTextContent(
        '01:30:00',
      );
      // Running run: measured against injected `now` (04:00 → 05:00 = 1h).
      expect(screen.getByLabelText('duration run running')).toHaveTextContent(
        '01:00:00',
      );
    });

    it('flags a quiet non-terminal run stale but not a terminal or fresh run (Req 9.1)', async () => {
      const listRuns = vi.fn().mockResolvedValue(
        connection([
          // Non-terminal and quiet for >1h before NOW → stale.
          run({
            runId: 'stale',
            status: 'RUNNING',
            workflowName: 'wf-stale',
            startedAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T02:00:00.000Z',
          }),
          // Non-terminal but updated recently (<1h before NOW) → fresh.
          run({
            runId: 'fresh',
            status: 'RUNNING',
            workflowName: 'wf-fresh',
            startedAt: '2024-01-01T04:30:00.000Z',
            updatedAt: '2024-01-01T04:45:00.000Z',
          }),
          // Terminal → never stale even though updatedAt is old.
          run({
            runId: 'done',
            status: 'COMPLETED',
            workflowName: 'wf-done',
            startedAt: '2024-01-01T00:00:00.000Z',
            stoppedAt: '2024-01-01T00:30:00.000Z',
            updatedAt: '2024-01-01T00:30:00.000Z',
          }),
        ]),
      );
      render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />);

      await screen.findByRole('table');

      // Exactly one stale badge, on the stale run only.
      const badges = screen.getAllByTestId('stale-badge');
      expect(badges).toHaveLength(1);
      expect(screen.getByLabelText('stale run stale')).toBeInTheDocument();
      expect(screen.queryByLabelText('stale run fresh')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('stale run done')).not.toBeInTheDocument();
    });
  });

  describe('filtering, sorting, grouping (Req 5.1, 7.3)', () => {
    const NOW = Date.parse('2024-01-01T06:00:00.000Z');

    function fleetRuns(): Run[] {
      return [
        run({
          runId: 'a',
          status: 'RUNNING',
          workflowName: 'wf-a',
          workflowId: 'wf-align',
          engineVersion: 'v1',
          batchId: 'batch-1',
          startedAt: '2024-01-01T05:00:00.000Z',
          stoppedAt: '2024-01-01T05:30:00.000Z', // 30m
          updatedAt: '2024-01-01T05:30:00.000Z',
        }),
        run({
          runId: 'b',
          status: 'COMPLETED',
          workflowName: 'wf-b',
          workflowId: 'wf-call',
          engineVersion: 'v2',
          startedAt: '2024-01-01T00:00:00.000Z',
          stoppedAt: '2024-01-01T03:00:00.000Z', // 3h (longest)
          updatedAt: '2024-01-01T03:00:00.000Z',
        }),
        run({
          runId: 'c',
          status: 'RUNNING',
          workflowName: 'wf-c',
          workflowId: 'wf-align',
          engineVersion: 'v1',
          batchId: 'batch-1',
          startedAt: '2024-01-01T04:00:00.000Z',
          stoppedAt: '2024-01-01T05:00:00.000Z', // 1h
          updatedAt: '2024-01-01T05:00:00.000Z',
        }),
      ];
    }

    it('filters the table by the selected status (Req 5.1)', async () => {
      const listRuns = vi.fn().mockResolvedValue(connection(fleetRuns()));
      const { container } = render(
        <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />,
      );

      await screen.findByRole('table');
      addStatusFilter(container, 'RUNNING');

      // Only the two RUNNING runs remain, in default recency order (a before c).
      await waitFor(() => {
        expect(workflowColumnText()).toEqual(['wf-a', 'wf-c']);
      });

      // Clearing the filter restores the full ordered list.
      fireEvent.click(screen.getByRole('button', { name: /clear filter/i }));
      await waitFor(() => {
        expect(workflowColumnText()).toEqual(['wf-a', 'wf-c', 'wf-b']);
      });
    });

    it('shows a filter-specific empty state when no runs match (Req 5.1)', async () => {
      const listRuns = vi.fn().mockResolvedValue(
        connection([
          run({ runId: 'a', status: 'RUNNING', workflowName: 'wf-a' }),
        ]),
      );
      const { container } = render(
        <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />,
      );

      await screen.findByRole('table');
      addStatusFilter(container, 'FAILED');

      expect(
        await screen.findByText(/no runs match the active filter/i),
      ).toBeInTheDocument();
    });

    it('filters the table by the selected workflow (Req 5.2)', async () => {
      const listRuns = vi.fn().mockResolvedValue(connection(fleetRuns()));
      const { container } = render(
        <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />,
      );

      await screen.findByRole('table');
      selectWorkflowFilter(container, 'wf-align');

      // Only runs on the wf-align workflow (a and c), in recency order.
      await waitFor(() => {
        expect(workflowColumnText()).toEqual(['wf-a', 'wf-c']);
      });
    });

    it('sorts the table by duration, longest first (Req 5.5)', async () => {
      const listRuns = vi.fn().mockResolvedValue(connection(fleetRuns()));
      const { container } = render(
        <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />,
      );

      await screen.findByRole('table');
      selectSortKey(container, 'duration');

      // b (3h) > c (1h) > a (30m) by wall-clock duration, descending default.
      await waitFor(() => {
        expect(workflowColumnText()).toEqual(['wf-b', 'wf-c', 'wf-a']);
      });
    });

    it('groups the table by engine version when toggled on (Req 7.3)', async () => {
      const listRuns = vi.fn().mockResolvedValue(connection(fleetRuns()));
      const { container } = render(
        <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />,
      );

      await screen.findByRole('table');
      toggleGroupByEngine(container);

      // One sub-table per engine version present in the data (v1 and v2).
      await waitFor(() => {
        expect(screen.getByTestId('engine-group-v1')).toBeInTheDocument();
      });
      expect(screen.getByTestId('engine-group-v2')).toBeInTheDocument();

      const headers = screen.getAllByTestId('engine-group-header');
      expect(headers.map((h) => h.textContent)).toEqual(['v1', 'v2']);

      // The v1 group holds runs a and c; the v2 group holds run b. The workflow
      // name appears in the Workflow link column, so assert presence (>= 1).
      const v1 = screen.getByTestId('engine-group-v1');
      expect(within(v1).getAllByText('wf-a').length).toBeGreaterThanOrEqual(1);
      expect(within(v1).getAllByText('wf-c').length).toBeGreaterThanOrEqual(1);
      const v2 = screen.getByTestId('engine-group-v2');
      expect(within(v2).getAllByText('wf-b').length).toBeGreaterThanOrEqual(1);
    });

    it('renders the Batch ID column, with a dash for standalone runs', async () => {
      const listRuns = vi.fn().mockResolvedValue(connection(fleetRuns()));
      render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />);

      await screen.findByRole('table');
      const badges = screen.getAllByTestId('batch-id').map((e) => e.textContent);
      // Runs a and c are in batch-1; run b is standalone (dash).
      expect(badges).toContain('batch-1');
      expect(badges).toContain('—');
    });

    it('groups the table by batch id when toggled on (independent of engine grouping)', async () => {
      const listRuns = vi.fn().mockResolvedValue(connection(fleetRuns()));
      const { container } = render(
        <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />,
      );

      await screen.findByRole('table');
      toggleGroupByBatch(container);

      // One sub-table for batch-1 and one for the standalone (No batch) group.
      await waitFor(() => {
        expect(screen.getByTestId('batch-group-batch-1')).toBeInTheDocument();
      });
      expect(screen.getByTestId('batch-group-No batch')).toBeInTheDocument();

      // The batch-1 group holds runs a and c.
      const b1 = screen.getByTestId('batch-group-batch-1');
      expect(within(b1).getAllByText('wf-a').length).toBeGreaterThanOrEqual(1);
      expect(within(b1).getAllByText('wf-c').length).toBeGreaterThanOrEqual(1);
      // The standalone group holds run b.
      const none = screen.getByTestId('batch-group-No batch');
      expect(within(none).getAllByText('wf-b').length).toBeGreaterThanOrEqual(1);

      // Turning on batch grouping did not leave engine grouping active.
      expect(screen.queryByTestId('engine-group-v1')).not.toBeInTheDocument();
    });
  });

  describe('free-form search and pagination', () => {
    /** Type into the fleet search box (Cloudscape TextFilter). */
    function typeSearch(value: string): void {
      const input = screen
        .getByTestId('fleet-search')
        .querySelector('input') as HTMLInputElement;
      fireEvent.change(input, { target: { value } });
    }

    it('filters the visible rows by the search query (Req: run search)', async () => {
      const listRuns = vi.fn().mockResolvedValue(
        connection([
          run({ runId: 'r1', name: 'nightly-rnaseq', workflowName: 'wf-rnaseq' }),
          run({ runId: 'r2', name: 'fetchngs-batch-1', workflowName: 'wf-fetch' }),
          run({ runId: 'r3', name: 'align-job', workflowName: 'wf-align' }),
        ]),
      );
      render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);
      await screen.findByRole('table');

      typeSearch('fetchngs');
      await waitFor(() => {
        expect(workflowColumnText()).toEqual(['wf-fetch']);
      });

      // Clearing the search restores all rows.
      typeSearch('');
      await waitFor(() => {
        expect(screen.getAllByRole('row').slice(1)).toHaveLength(3);
      });
    });

    it('matches on run id and status too', async () => {
      const listRuns = vi.fn().mockResolvedValue(
        connection([
          run({ runId: 'abc-123', name: 'x', status: 'RUNNING', workflowName: 'wf-x' }),
          run({ runId: 'def-456', name: 'y', status: 'FAILED', workflowName: 'wf-y' }),
        ]),
      );
      render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);
      await screen.findByRole('table');

      typeSearch('def-456');
      await waitFor(() => expect(workflowColumnText()).toEqual(['wf-y']));

      typeSearch('running');
      await waitFor(() => expect(workflowColumnText()).toEqual(['wf-x']));
    });

    it('paginates the flat list at 25 per page and navigates pages', async () => {
      // 30 runs: page 1 shows 25, page 2 shows 5. Use recency order (default);
      // give descending updatedAt so run order is deterministic.
      const many = Array.from({ length: 30 }, (_, i) =>
        run({
          runId: `r${String(i).padStart(2, '0')}`,
          workflowName: `wf-${String(i).padStart(2, '0')}`,
          updatedAt: `2024-01-01T${String(i).padStart(2, '0')}:00:00.000Z`,
        }),
      );
      const listRuns = vi.fn().mockResolvedValue(connection(many));
      render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} />);
      await screen.findByRole('table');

      // Page 1: 25 rows.
      expect(screen.getAllByRole('row').slice(1)).toHaveLength(25);

      // Navigate to page 2 via the Pagination control (aria-label "Next page").
      fireEvent.click(screen.getByRole('button', { name: /next page/i }));
      await waitFor(() => {
        expect(screen.getAllByRole('row').slice(1)).toHaveLength(5);
      });
    });

    it('resets to page 1 when a search narrows the list', async () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        run({
          runId: `r${String(i).padStart(2, '0')}`,
          name: i === 0 ? 'only-match' : `run-${i}`,
          workflowName: `wf-${String(i).padStart(2, '0')}`,
          updatedAt: `2024-01-01T${String(i).padStart(2, '0')}:00:00.000Z`,
        }),
      );
      const listRuns = vi.fn().mockResolvedValue(connection(many));
      const { container } = render(
        <FleetView listRuns={listRuns} subscribe={noopSubscribe} />,
      );
      await screen.findByRole('table');

      // Go to page 2 first.
      fireEvent.click(screen.getByRole('button', { name: /next page/i }));
      await waitFor(() =>
        expect(screen.getAllByRole('row').slice(1)).toHaveLength(5),
      );

      // Searching narrows to a single match and snaps back to page 1.
      const input = container
        .querySelector('[data-testid="fleet-search"] input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'only-match' } });
      await waitFor(() => {
        expect(workflowColumnText()).toEqual(['wf-00']);
      });
    });
  });
});
