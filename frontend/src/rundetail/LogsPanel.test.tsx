import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import LogsPanel from './LogsPanel';
import type { RunLogs } from '../api/types';

function logs(events: Array<{ timestamp: number; message: string }>): RunLogs {
  return { logStreamName: 'run/r1/engine', events, nextToken: null };
}

describe('LogsPanel', () => {
  it('loads and renders log lines for the given stream', async () => {
    const getRunLogs = vi.fn().mockResolvedValue(
      logs([
        { timestamp: 1704067200000, message: 'staging genome.fasta' },
        { timestamp: 1704067201000, message: 'submitted process FASTQC' },
      ]),
    );
    render(<LogsPanel runId="r1" stream="ENGINE" getRunLogs={getRunLogs} />);

    const out = await screen.findByTestId('logs-output');
    expect(out).toHaveTextContent('staging genome.fasta');
    expect(out).toHaveTextContent('submitted process FASTQC');
    expect(getRunLogs).toHaveBeenCalledWith({
      runId: 'r1',
      stream: 'ENGINE',
      taskId: undefined,
    });
  });

  it('shows an empty message when there are no events yet', async () => {
    const getRunLogs = vi.fn().mockResolvedValue(logs([]));
    render(<LogsPanel runId="r1" stream="TASK" taskId="t1" getRunLogs={getRunLogs} />);
    expect(await screen.findByText(/no log events yet/i)).toBeInTheDocument();
  });

  it('re-fetches when Refresh logs is clicked', async () => {
    const getRunLogs = vi.fn().mockResolvedValue(logs([{ timestamp: 1, message: 'x' }]));
    render(<LogsPanel runId="r1" stream="RUN" getRunLogs={getRunLogs} />);
    await screen.findByTestId('logs-output');
    expect(getRunLogs).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /refresh logs/i }));
    await waitFor(() => expect(getRunLogs).toHaveBeenCalledTimes(2));
  });

  it('shows an error with retry when the fetch fails', async () => {
    const getRunLogs = vi.fn().mockRejectedValue(new Error('boom'));
    render(<LogsPanel runId="r1" stream="RUN" getRunLogs={getRunLogs} />);
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('filters lines by the search box (#2)', async () => {
    const getRunLogs = vi.fn().mockResolvedValue(
      logs([
        { timestamp: 1, message: 'staging genome.fasta' },
        { timestamp: 2, message: 'submitted process FASTQC' },
        { timestamp: 3, message: 'submitted process STAR_ALIGN' },
      ]),
    );
    render(<LogsPanel runId="r1" stream="ENGINE" getRunLogs={getRunLogs} />);
    await screen.findByTestId('logs-output');

    fireEvent.change(screen.getByLabelText(/search logs/i), {
      target: { value: 'FASTQC' },
    });
    await waitFor(() => {
      const out = screen.getByTestId('logs-output');
      expect(out).toHaveTextContent('FASTQC');
      expect(out).not.toHaveTextContent('STAR_ALIGN');
      expect(out).not.toHaveTextContent('genome.fasta');
    });
  });

  it('shows a no-match state when the search matches nothing', async () => {
    const getRunLogs = vi.fn().mockResolvedValue(
      logs([{ timestamp: 1, message: 'staging genome.fasta' }]),
    );
    render(<LogsPanel runId="r1" stream="ENGINE" getRunLogs={getRunLogs} />);
    await screen.findByTestId('logs-output');
    fireEvent.change(screen.getByLabelText(/search logs/i), {
      target: { value: 'nonexistent-xyz' },
    });
    expect(await screen.findByTestId('logs-no-match')).toBeInTheDocument();
  });
});
