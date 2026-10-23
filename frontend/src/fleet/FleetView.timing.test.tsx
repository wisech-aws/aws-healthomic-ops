import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Profiler } from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import createWrapper from '@cloudscape-design/components/test-utils/dom';
import FleetView from './FleetView';
import type { SubscribeRuns } from './FleetView';
import type { Run, RunConnection } from '../api/types';
import type { SubscriptionHandlers } from '../api/client';
import { createFleetCache } from './fleetCache';
import { resetFleetLoadTimingsForTests } from './loadTiming';
import type * as LoadTiming from './loadTiming';

// Passthrough mock of the timing module with a switch that replaces the timer
// with a no-op, so the render-count test can compare instrumented vs not.
const timing = vi.hoisted(() => ({ disabled: false }));
vi.mock('./loadTiming', async (importOriginal) => {
  const actual = await importOriginal<typeof LoadTiming>();
  return {
    ...actual,
    startFleetLoadTimer: (...args: Parameters<typeof actual.startFleetLoadTimer>) =>
      timing.disabled
        ? { seq: 0, markFirstRows: () => {}, finish: () => {} }
        : actual.startFleetLoadTimer(...args),
  };
});

const NOW = Date.parse('2024-06-15T12:00:00.000Z');
const noopSubscribe: SubscribeRuns = () => ({ unsubscribe: () => {} });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function deferredListRuns() {
  const pages: Deferred<RunConnection>[] = [];
  const listRuns = vi.fn(() => {
    const d = deferred<RunConnection>();
    pages.push(d);
    return d.promise;
  });
  return { listRuns, pages };
}
async function settle(d: Deferred<RunConnection>, value: RunConnection): Promise<void> {
  await act(async () => {
    d.resolve(value);
  });
}
function runs(prefix: string, count: number): Run[] {
  return Array.from({ length: count }, (_, i) => ({
    runId: `${prefix}-${i}`,
    name: `secret-name-${prefix}-${i}`,
    workflowName: `wf-${prefix}-${i}`,
    updatedAt: new Date(Date.parse('2024-06-10T12:00:00.000Z') - i * 60_000).toISOString(),
  }));
}
function rowCount(): number {
  return screen.queryAllByRole('row').length - 1;
}
function fleetLines(info: ReturnType<typeof vi.spyOn>): string[] {
  return info.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((l: string) => l.startsWith('[fleet]'));
}

describe('FleetView — load timing (D)', () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timing.disabled = false;
    resetFleetLoadTimingsForTests();
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cold load: first-rows mark after page 1 renders, one cold line at completion', async () => {
    const mark = vi.spyOn(performance, 'mark');
    const measure = vi.spyOn(performance, 'measure');
    const { listRuns, pages } = deferredListRuns();
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />);

    const markNames = () => mark.mock.calls.map((c) => c[0]);
    expect(markNames()).toContain('fleet:start:1');
    expect(markNames()).not.toContain('fleet:first-rows:1');

    await settle(pages[0], { items: runs('p1', 3), nextToken: 't1' });
    expect(rowCount()).toBe(3);
    expect(markNames()).toContain('fleet:first-rows:1');
    expect(fleetLines(info)).toEqual([]);

    await settle(pages[1], { items: runs('p2', 2), nextToken: null });
    const lines = fleetLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[fleet\] cold load: first rows [\d,]+ ms, complete [\d,]+ ms, 2 pages, 5 runs$/,
    );
    expect(lines[0]).not.toMatch(/secret-name|p1-0/);
    expect(measure.mock.calls.map((c) => c[0])).toEqual([
      'fleet:first-rows',
      'fleet:complete',
    ]);
  });

  it('Refresh with rows shown logs a "rows kept" refresh line', async () => {
    const listRuns = vi.fn().mockResolvedValue({ items: runs('r', 2), nextToken: null });
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />);
    await waitFor(() => expect(fleetLines(info)).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /refresh runs/i }));
    await waitFor(() => expect(fleetLines(info)).toHaveLength(2));
    expect(fleetLines(info)[1]).toMatch(
      /^\[fleet\] refresh: rows kept, complete [\d,]+ ms, 1 page, 2 runs$/,
    );
  });

  it('a reconnect refetch logs a reconnect line', async () => {
    let handlers: SubscriptionHandlers<Run> | undefined;
    const subscribe: SubscribeRuns = (h) => {
      handlers = h;
      return { unsubscribe: () => {} };
    };
    const listRuns = vi.fn().mockResolvedValue({ items: runs('r', 1), nextToken: null });
    render(<FleetView listRuns={listRuns} subscribe={subscribe} now={NOW} />);
    await waitFor(() => expect(fleetLines(info)).toHaveLength(1));

    act(() => {
      handlers?.error?.(new Error('socket dropped'));
    });
    await waitFor(() => expect(fleetLines(info)).toHaveLength(2), { timeout: 4000 });
    expect(fleetLines(info)[1]).toMatch(/^\[fleet\] reconnect: rows kept, complete/);
  });

  it('a warm mount logs a warm revalidate line', async () => {
    const cache = createFleetCache();
    cache.set('default', { runs: runs('c', 2), loadCapped: false, lastLoadedAt: 1 });
    const listRuns = vi.fn().mockResolvedValue({ items: runs('c', 3), nextToken: null });
    render(
      <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} cache={cache} />,
    );
    expect(rowCount()).toBe(2);
    await waitFor(() => expect(fleetLines(info)).toHaveLength(1));
    expect(fleetLines(info)[0]).toMatch(
      /^\[fleet\] warm revalidate: cached rows shown instantly, revalidate complete [\d,]+ ms, 1 page, \d+ runs$/,
    );
  });

  it('a superseded load logs "superseded" and the newer load logs its own line', async () => {
    const { listRuns, pages } = deferredListRuns();
    const { container } = render(
      <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />,
    );
    await settle(pages[0], { items: runs('old', 2), nextToken: 't1' });

    const picker = createWrapper(container).findDateRangePicker()!;
    picker.openDropdown();
    picker.findDropdown()!.findRelativeRangeRadioGroup()!.findInputByValue('prev-7')!.click();
    picker.findDropdown()!.findApplyButton()!.click();
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(3));
    expect(fleetLines(info)).toEqual([
      expect.stringMatching(/^\[fleet\] cold load: superseded after [\d,]+ ms, 1 page, 2 runs$/),
    ]);

    await settle(pages[2], { items: runs('new', 1), nextToken: null });
    await settle(pages[1], { items: runs('stale', 1), nextToken: null });
    const lines = fleetLines(info);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^\[fleet\] cold load: first rows [\d,]+ ms, complete [\d,]+ ms, 1 page, 1 run$/);
  });

  it('still renders rows and logs without the User Timing API', async () => {
    // Cloudscape's Table itself reads performance.now(), so keep only that;
    // mark/measure/clearMarks are absent. (A fully undefined `performance` is
    // covered by loadTiming.test.ts.)
    const realNow = performance.now.bind(performance);
    vi.stubGlobal('performance', { now: realNow });
    const listRuns = vi.fn().mockResolvedValue({ items: runs('r', 2), nextToken: null });
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />);
    await waitFor(() => expect(rowCount()).toBe(2));
    await waitFor(() => expect(fleetLines(info)).toHaveLength(1));
    expect(fleetLines(info)[0]).toMatch(/^\[fleet\] cold load: first rows/);
  });

  it('still renders rows and logs when mark/measure throw', async () => {
    vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('mark broke');
    });
    vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new Error('measure broke');
    });
    const listRuns = vi.fn().mockResolvedValue({ items: runs('r', 2), nextToken: null });
    render(<FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />);
    await waitFor(() => expect(rowCount()).toBe(2));
    await waitFor(() => expect(fleetLines(info)).toHaveLength(1));
  });

  it('instrumentation adds no renders', async () => {
    async function commitsForColdLoad(): Promise<number> {
      let commits = 0;
      const listRuns = vi.fn().mockResolvedValue({ items: runs('r', 2), nextToken: null });
      const { unmount } = render(
        <Profiler id="fleet" onRender={() => (commits += 1)}>
          <FleetView listRuns={listRuns} subscribe={noopSubscribe} now={NOW} />
        </Profiler>,
      );
      await waitFor(() => expect(rowCount()).toBe(2));
      await waitFor(() =>
        expect(screen.getByTestId('fleet-last-refreshed')).toBeInTheDocument(),
      );
      unmount();
      return commits;
    }
    const instrumented = await commitsForColdLoad();
    timing.disabled = true;
    const bare = await commitsForColdLoad();
    expect(fleetLines(info)).toHaveLength(1);
    expect(instrumented).toBe(bare);
  });
});
