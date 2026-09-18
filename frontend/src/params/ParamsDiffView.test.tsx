import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ParamsDiffView from './ParamsDiffView';
import type { Run } from '../api/types';

function makeRun(partial: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    name: 'my-run',
    status: 'COMPLETED',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...partial,
  };
}

/**
 * Builds an injectable `getRun` stub that resolves each id to the supplied run,
 * mirroring the two-run query the view issues (one call per side, Req 10.4).
 */
function stubGetRun(
  byId: Record<string, Run | null>,
): (runId: string) => Promise<Run | null> {
  return vi.fn(async (runId: string) => byId[runId] ?? null);
}

describe('ParamsDiffView', () => {
  it('renders the cross-workflow warning when the two runs are from different workflows (Req 6.7)', async () => {
    const left = makeRun({
      runId: 'run-left',
      workflowId: 'wf-1',
      parameters: JSON.stringify({ input: 'a' }),
    });
    const right = makeRun({
      runId: 'run-right',
      workflowId: 'wf-2',
      parameters: JSON.stringify({ input: 'a' }),
    });

    render(
      <ParamsDiffView
        leftRunId="run-left"
        rightRunId="run-right"
        getRun={stubGetRun({ 'run-left': left, 'run-right': right })}
      />,
    );

    // Await the ready state (the diff body renders under this label).
    await screen.findByLabelText('parameters diff');
    expect(screen.getByTestId('cross-workflow-warning')).toBeInTheDocument();
  });

  it('does not render the cross-workflow warning when both runs share the same workflow (Req 6.7)', async () => {
    const left = makeRun({
      runId: 'run-left',
      workflowId: 'wf-1',
      parameters: JSON.stringify({ input: 'a' }),
    });
    const right = makeRun({
      runId: 'run-right',
      workflowId: 'wf-1',
      parameters: JSON.stringify({ input: 'b' }),
    });

    render(
      <ParamsDiffView
        leftRunId="run-left"
        rightRunId="run-right"
        getRun={stubGetRun({ 'run-left': left, 'run-right': right })}
      />,
    );

    await screen.findByLabelText('parameters diff');
    expect(
      screen.queryByTestId('cross-workflow-warning'),
    ).not.toBeInTheDocument();
  });

  it('renders a per-side parse-error notice when a run has present-but-unparseable parameters (Req 6.5)', async () => {
    // Left parameters are a present, non-JSON string; right side is valid JSON.
    const left = makeRun({
      runId: 'run-left',
      workflowId: 'wf-1',
      parameters: 'this is not json',
    });
    const right = makeRun({
      runId: 'run-right',
      workflowId: 'wf-1',
      parameters: JSON.stringify({ input: 'a' }),
    });

    render(
      <ParamsDiffView
        leftRunId="run-left"
        rightRunId="run-right"
        getRun={stubGetRun({ 'run-left': left, 'run-right': right })}
      />,
    );

    await screen.findByLabelText('parameters diff');
    // Only the offending (left) side shows a parse-error notice.
    expect(screen.getByTestId('left-parse-error')).toBeInTheDocument();
    expect(screen.queryByTestId('right-parse-error')).not.toBeInTheDocument();
  });

  it('renders both per-side parse-error notices when both runs have unparseable parameters (Req 6.5)', async () => {
    const left = makeRun({
      runId: 'run-left',
      workflowId: 'wf-1',
      parameters: 'nope',
    });
    const right = makeRun({
      runId: 'run-right',
      workflowId: 'wf-1',
      parameters: '{ still: not json',
    });

    render(
      <ParamsDiffView
        leftRunId="run-left"
        rightRunId="run-right"
        getRun={stubGetRun({ 'run-left': left, 'run-right': right })}
      />,
    );

    await screen.findByLabelText('parameters diff');
    expect(screen.getByTestId('left-parse-error')).toBeInTheDocument();
    expect(screen.getByTestId('right-parse-error')).toBeInTheDocument();
  });
});
