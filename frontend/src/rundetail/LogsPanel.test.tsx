import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import LogsPanel from './LogsPanel';
import { logContent } from './logsExport';
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

  // OPT-IN tail (failed-run triage): the panel requests the newest slice first
  // and shows an honest hint that it is doing so.
  it('requests tail:true and renders the tail hint when the tail prop is set', async () => {
    const getRunLogs = vi.fn().mockResolvedValue(
      logs([{ timestamp: 1, message: '[ERROR] boom at the end' }]),
    );
    render(<LogsPanel runId="r1" stream="ENGINE" tail getRunLogs={getRunLogs} />);
    await screen.findByTestId('logs-output');
    expect(getRunLogs).toHaveBeenCalledWith({
      runId: 'r1',
      stream: 'ENGINE',
      taskId: undefined,
      tail: true,
    });
    expect(screen.getByTestId('logs-tail-hint')).toHaveTextContent(
      /most recent log lines/i,
    );
  });

  // Default (successful-run) path protection: WITHOUT the tail prop the panel
  // must call getRunLogs WITHOUT a tail key, and render no tail hint.
  it('does not request tail and shows no tail hint by default', async () => {
    const getRunLogs = vi.fn().mockResolvedValue(
      logs([{ timestamp: 1, message: 'staging genome.fasta' }]),
    );
    render(<LogsPanel runId="r1" stream="ENGINE" getRunLogs={getRunLogs} />);
    await screen.findByTestId('logs-output');
    expect(getRunLogs).toHaveBeenCalledWith({
      runId: 'r1',
      stream: 'ENGINE',
      taskId: undefined,
    });
    expect(getRunLogs.mock.calls[0][0]).not.toHaveProperty('tail');
    expect(screen.queryByTestId('logs-tail-hint')).not.toBeInTheDocument();
  });

  // Download (#4): exports EXACTLY the loaded events as a .log file via the
  // Blob/URL/anchor pattern, with no refetch and no fabrication.
  describe('download', () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;

    afterEach(() => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      vi.restoreAllMocks();
    });

    it('exports exactly the loaded events with the task filename and triggers a click', async () => {
      const events = [
        { timestamp: 1704067200000, message: 'staging genome.fasta' },
        { timestamp: 1704067201000, message: '[ERROR] alignment failed' },
      ];
      const getRunLogs = vi.fn().mockResolvedValue(logs(events));

      let captured: Blob | null = null;
      URL.createObjectURL = vi.fn((blob: Blob) => {
        captured = blob;
        return 'blob:mock-url';
      }) as unknown as typeof URL.createObjectURL;
      const revokeSpy = vi.fn();
      URL.revokeObjectURL = revokeSpy as unknown as typeof URL.revokeObjectURL;

      let downloadAttr: string | null = null;
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) {
          downloadAttr = this.download;
        });

      render(
        <LogsPanel runId="r1" stream="TASK" taskId="t1" getRunLogs={getRunLogs} />,
      );
      await screen.findByTestId('logs-output');

      const downloadBtn = screen.getByRole('button', { name: /download logs/i });
      expect(downloadBtn).not.toBeDisabled();
      fireEvent.click(downloadBtn);

      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(downloadAttr).toBe('r1-t1.log');
      expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url');
      // No refetch happened on download.
      expect(getRunLogs).toHaveBeenCalledTimes(1);

      // The exported text equals logContent over the FULL loaded events.
      expect(captured).not.toBeNull();
      const text = await (captured as unknown as Blob).text();
      expect(text).toBe(logContent(events));
    });

    it('uses the stream name in the filename when there is no taskId', async () => {
      const getRunLogs = vi
        .fn()
        .mockResolvedValue(logs([{ timestamp: 1, message: 'x' }]));
      URL.createObjectURL = vi.fn(() => 'blob:mock-url') as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
      let downloadAttr: string | null = null;
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          downloadAttr = this.download;
        },
      );

      render(<LogsPanel runId="r1" stream="ENGINE" getRunLogs={getRunLogs} />);
      await screen.findByTestId('logs-output');
      fireEvent.click(screen.getByRole('button', { name: /download logs/i }));
      expect(downloadAttr).toBe('r1-ENGINE.log');
    });

    it('disables the Download button when there are no events', async () => {
      const getRunLogs = vi.fn().mockResolvedValue(logs([]));
      render(<LogsPanel runId="r1" stream="TASK" taskId="t1" getRunLogs={getRunLogs} />);
      await screen.findByText(/no log events yet/i);
      expect(screen.getByRole('button', { name: /download logs/i })).toBeDisabled();
    });
  });
});
