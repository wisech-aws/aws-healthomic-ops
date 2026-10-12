import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DurationBucketPopovers, { runHref } from './DurationBucketPopovers';
import { runsInBuckets } from './durationBuckets';
import type { HistogramBucket, RunPoint } from '../api/types';

function run(partial: Partial<RunPoint> & Pick<RunPoint, 'runId'>): RunPoint {
  return {
    stoppedAt: '2024-01-02T10:00:00.000Z',
    status: 'COMPLETED',
    durationMs: 600000,
    ...partial,
  };
}

const BUCKETS: HistogramBucket[] = [
  { lo: 300000, hi: 600000, count: 0 },
  { lo: 600000, hi: 900000, count: 0 },
];

describe('runHref', () => {
  it('builds an absolute in-app URL with the #/run/<id> deep-link hash', () => {
    const href = runHref('run-xyz');
    expect(href.startsWith(`${window.location.origin}${window.location.pathname}`)).toBe(true);
    expect(href.endsWith('#/run/run-xyz')).toBe(true);
  });

  it('URL-encodes reserved characters in the run id', () => {
    expect(runHref('a/b c')).toContain('#/run/a%2Fb%20c');
  });
});

describe('DurationBucketPopovers', () => {
  it('renders no trigger when every bucket is empty', () => {
    const { container } = render(
      <DurationBucketPopovers buckets={BUCKETS} runsByBucket={[[], []]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  /** The section's expand/collapse toggle (the button carrying aria-expanded). */
  function sectionToggle(): HTMLElement {
    const section = screen.getByTestId('reports-bucket-section');
    const toggle = within(section)
      .getAllByRole('button')
      .find((el) => el.getAttribute('aria-expanded') != null);
    if (toggle == null) {
      throw new Error('expandable-section toggle not found');
    }
    return toggle;
  }

  it('renders the bucket browser COLLAPSED by default', () => {
    const runsByBucket = [[run({ runId: 'a', durationMs: 450000 })], []];
    render(<DurationBucketPopovers buckets={BUCKETS} runsByBucket={runsByBucket} />);
    // The ExpandableSection exists and its toggle reports the collapsed state.
    expect(screen.getByTestId('reports-bucket-section')).toBeInTheDocument();
    expect(sectionToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders a trigger only for non-empty buckets after expanding', () => {
    const runsByBucket = [[run({ runId: 'a', durationMs: 450000 })], []];
    render(<DurationBucketPopovers buckets={BUCKETS} runsByBucket={runsByBucket} />);
    fireEvent.click(sectionToggle());
    expect(screen.getAllByTestId('reports-bucket-trigger')).toHaveLength(1);
    expect(screen.getByTestId('reports-bucket-trigger')).toHaveTextContent('5–10 min (1)');
  });

  it('header text reflects the real total runs and non-empty bucket count', () => {
    const points: RunPoint[] = [
      run({ runId: 'b0', durationMs: 450000 }),
      run({ runId: 'b1a', durationMs: 600000 }),
      run({ runId: 'b1b', durationMs: 900000 }),
      run({ runId: 'skip', durationMs: null }),
    ];
    const mapped = runsInBuckets(points, BUCKETS);
    render(<DurationBucketPopovers buckets={BUCKETS} runsByBucket={mapped} />);
    // One run in bucket 0, two in bucket 1 → 3 real runs across 2 buckets.
    expect(
      screen.getByText(/Browse runs by duration bucket \(3 runs across 2 buckets\)/),
    ).toBeInTheDocument();
  });

  it('opens a popover with new-tab run links on click after expanding', () => {
    const runsByBucket = [
      [run({ runId: 'r-a', durationMs: 450000 })],
      [run({ runId: 'r-b', durationMs: 700000 }), run({ runId: 'r-c', durationMs: 900000 })],
    ];
    render(<DurationBucketPopovers buckets={BUCKETS} runsByBucket={runsByBucket} />);

    fireEvent.click(sectionToggle());
    const triggers = screen.getAllByTestId('reports-bucket-trigger');
    fireEvent.click(triggers[1]);

    const links = screen.getAllByTestId('reports-bucket-run-link');
    expect(links.map((l) => l.textContent?.trim())).toEqual(['r-b', 'r-c']);
    const first = links[0];
    expect(first.getAttribute('href')).toContain('#/run/r-b');
    expect(first.getAttribute('target')).toBe('_blank');
    expect(first.getAttribute('rel')).toContain('noopener');
  });

  it('caps the visible list at 50 and shows a "+ K more" note for a large bucket', () => {
    const many = Array.from({ length: 73 }, (_, i) =>
      run({ runId: `run-${i}`, durationMs: 450000 }),
    );
    render(
      <DurationBucketPopovers buckets={BUCKETS} runsByBucket={[many, []]} />,
    );
    fireEvent.click(sectionToggle());
    fireEvent.click(screen.getByTestId('reports-bucket-trigger'));

    expect(screen.getAllByTestId('reports-bucket-run-link')).toHaveLength(50);
    expect(screen.getByText('+ 23 more')).toBeInTheDocument();
  });

  it('integrates with runsInBuckets so per-bucket link counts match the mapping', () => {
    const points: RunPoint[] = [
      run({ runId: 'b0', durationMs: 450000 }),
      run({ runId: 'b1a', durationMs: 600000 }),
      run({ runId: 'b1b', durationMs: 900000 }),
      run({ runId: 'skip', durationMs: null }),
    ];
    const mapped = runsInBuckets(points, BUCKETS);
    render(<DurationBucketPopovers buckets={BUCKETS} runsByBucket={mapped} />);

    fireEvent.click(sectionToggle());
    const triggers = screen.getAllByTestId('reports-bucket-trigger');
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[0]);
    expect(
      screen.getAllByTestId('reports-bucket-run-link').map((l) => l.textContent?.trim()),
    ).toEqual(['b0']);
  });
});
