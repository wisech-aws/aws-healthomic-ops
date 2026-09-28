/**
 * In-memory sample data for LOCAL MOCK mode (see {@link isLocalMockMode}).
 *
 * These fixtures let the dashboard render a realistic fleet + run detail view
 * on a developer machine with no deployed backend and no signed-in Cognito
 * user. They are only referenced by the client's mock path and are never
 * bundled into a real deployment's data flow.
 */
import type { Run, Task, WorkflowGroup, WorkflowReport, AggregateMetric, RunPoint } from './types';
import type { StaticGraph } from '../taskview/types';

/** A small fleet of runs spanning several statuses, newest first by updatedAt. */
export const MOCK_RUNS: Run[] = [
  {
    runId: 'run-1001',
    status: 'RUNNING',
    name: 'rnaseq-nightly',
    workflowId: 'wf-rnaseq',
    workflowName: 'RNA-seq (nf-core)',
    createdAt: '2024-01-05T09:58:00.000Z',
    startedAt: '2024-01-05T10:00:00.000Z',
    stoppedAt: null,
    updatedAt: '2024-01-05T10:42:00.000Z',
    outputUri: 's3://demo-bucket/run-outputs/rnaseq-nightly/run-1001',
    engineVersion: '25.10.0',
    parameters: JSON.stringify({
      input: 's3://demo-bucket/samplesheets/test.csv',
      fasta: 's3://demo-bucket/reference/genome.fasta',
      gtf: 's3://demo-bucket/reference/genes.gtf.gz',
      validate_params: false,
      outdir: '/mnt/workflow/pubdir',
    }),
  },
  {
    runId: 'run-1000',
    status: 'COMPLETED',
    name: 'variant-calling-batch-42',
    workflowId: 'wf-gatk',
    workflowName: 'GATK Variant Calling',
    createdAt: '2024-01-05T08:00:00.000Z',
    startedAt: '2024-01-05T08:02:00.000Z',
    stoppedAt: '2024-01-05T09:15:00.000Z',
    updatedAt: '2024-01-05T09:15:00.000Z',
  },
  {
    runId: 'run-0999',
    status: 'FAILED',
    name: 'alignment-hg38',
    workflowId: 'wf-align',
    workflowName: 'BWA Alignment',
    createdAt: '2024-01-04T22:00:00.000Z',
    startedAt: '2024-01-04T22:01:00.000Z',
    stoppedAt: '2024-01-04T22:07:30.000Z',
    updatedAt: '2024-01-04T22:07:30.000Z',
  },
  {
    runId: 'run-0998',
    status: 'PENDING',
    name: 'qc-fastqc',
    workflowId: 'wf-qc',
    workflowName: 'FastQC',
    createdAt: '2024-01-04T20:00:00.000Z',
    startedAt: null,
    stoppedAt: null,
    updatedAt: '2024-01-04T20:00:00.000Z',
  },
];

/** Tasks per run, keyed by runId. Used by the run detail view in mock mode. */
export const MOCK_TASKS_BY_RUN: Readonly<Record<string, Task[]>> = {
  'run-1001': [
    {
      runId: 'run-1001',
      taskId: 't-1',
      name: 'fastqc',
      status: 'COMPLETED',
      cpus: 2,
      memory: 4,
      createdAt: '2024-01-05T10:00:00.000Z',
      startedAt: '2024-01-05T10:00:30.000Z',
      stoppedAt: '2024-01-05T10:05:00.000Z',
      updatedAt: '2024-01-05T10:05:00.000Z',
    },
    {
      runId: 'run-1001',
      taskId: 't-2',
      name: 'align',
      status: 'RUNNING',
      cpus: 8,
      memory: 32,
      createdAt: '2024-01-05T10:05:00.000Z',
      startedAt: '2024-01-05T10:05:30.000Z',
      stoppedAt: null,
      updatedAt: '2024-01-05T10:42:00.000Z',
    },
    {
      runId: 'run-1001',
      taskId: 't-3',
      name: 'quantify',
      status: 'PENDING',
      cpus: 4,
      memory: 16,
      createdAt: null,
      startedAt: null,
      stoppedAt: null,
      updatedAt: '2024-01-05T10:05:00.000Z',
    },
  ],
  'run-1000': [
    {
      runId: 'run-1000',
      taskId: 't-a',
      name: 'haplotype-caller',
      status: 'COMPLETED',
      cpus: 8,
      memory: 32,
      createdAt: '2024-01-05T08:02:00.000Z',
      startedAt: '2024-01-05T08:03:00.000Z',
      stoppedAt: '2024-01-05T09:10:00.000Z',
      updatedAt: '2024-01-05T09:10:00.000Z',
    },
    {
      runId: 'run-1000',
      taskId: 't-b',
      name: 'genotype-gvcfs',
      status: 'COMPLETED',
      cpus: 4,
      memory: 16,
      createdAt: '2024-01-05T09:10:00.000Z',
      startedAt: '2024-01-05T09:10:30.000Z',
      stoppedAt: '2024-01-05T09:15:00.000Z',
      updatedAt: '2024-01-05T09:15:00.000Z',
    },
  ],
  'run-0999': [
    {
      runId: 'run-0999',
      taskId: 't-x',
      name: 'bwa-mem',
      status: 'FAILED',
      cpus: 8,
      memory: 32,
      createdAt: '2024-01-04T22:01:00.000Z',
      startedAt: '2024-01-04T22:01:30.000Z',
      stoppedAt: '2024-01-04T22:07:30.000Z',
      updatedAt: '2024-01-04T22:07:30.000Z',
    },
  ],
  'run-0998': [],
};


/**
 * Static workflow graphs per run, keyed by runId. Supplied to the run detail
 * view in local mock mode so the highest-fidelity True_DAG layer renders (node
 * names match the mock task names for the status overlay). Runs without an
 * entry fall back to the Inferred_DAG / Timeline layers.
 *
 * Each graph carries an honest `fidelity` reflecting its source language: the
 * nf-core RNA-seq workflow (`wf-rnaseq`) is Nextflow, so its cross-file edges
 * are best-effort (`approximate`); the GATK workflow (`wf-gatk`) is WDL, whose
 * call graph is authoritative (`exact`).
 */
export const MOCK_GRAPHS_BY_RUN: Readonly<Record<string, StaticGraph>> = {
  'run-1001': {
    workflowId: 'wf-rnaseq',
    nodes: [
      { id: 'n1', name: 'fastqc' },
      { id: 'n2', name: 'align' },
      { id: 'n3', name: 'quantify' },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
    fidelity: 'approximate',
  },
  'run-1000': {
    workflowId: 'wf-gatk',
    nodes: [
      { id: 'g1', name: 'haplotype-caller' },
      { id: 'g2', name: 'genotype-gvcfs' },
    ],
    edges: [{ from: 'g1', to: 'g2' }],
    fidelity: 'exact',
  },
};

// ── Reports mock data (workflow-performance-reports) ────────────────────────

/** Sample workflow+version groups for the Reports pickers in mock mode. */
export const MOCK_WORKFLOW_GROUPS: WorkflowGroup[] = [
  {
    workflowName: 'RNA-seq (nf-core)',
    versionName: '3.14.0',
    workflowIds: ['wf-rnaseq'],
    runCount: 6,
  },
  {
    workflowName: 'GATK Variant Calling',
    versionName: '(unversioned)',
    workflowIds: ['wf-gatk'],
    runCount: 4,
  },
];

/** Build a deterministic sample report so the Reports view renders in mock mode. */
export function mockWorkflowReport(
  workflowName: string,
  versionName: string,
  start: string,
  end: string,
): WorkflowReport {
  // A small set of per-run points; one run intentionally lacks utilization so
  // the "N of M" denominator + Metric_Unavailable_State are exercised honestly.
  const timeline: RunPoint[] = [
    {
      runId: 'run-a',
      stoppedAt: '2024-01-02T10:00:00.000Z',
      status: 'COMPLETED',
      durationMs: 1_200_000,
      meanCpu: 2.1,
      peakCpu: 3.8,
      meanMemoryGiB: 3.2,
      peakMemoryGiB: 5.9,
      cpuHours: 1.4,
      peakConcurrentTasks: 12,
      taskCount: 40,
      failedTaskCount: 0,
    },
    {
      runId: 'run-b',
      stoppedAt: '2024-01-03T10:00:00.000Z',
      status: 'COMPLETED',
      durationMs: 1_500_000,
      meanCpu: 2.6,
      peakCpu: 4.0,
      meanMemoryGiB: 3.8,
      peakMemoryGiB: 6.0,
      cpuHours: 1.9,
      peakConcurrentTasks: 15,
      taskCount: 41,
      failedTaskCount: 1,
    },
    {
      runId: 'run-c',
      stoppedAt: '2024-01-04T10:00:00.000Z',
      status: 'FAILED',
      durationMs: 600_000,
      // utilization unavailable for this run (no metric-emission permission).
      meanCpu: null,
      peakCpu: null,
      meanMemoryGiB: null,
      peakMemoryGiB: null,
      cpuHours: null,
      peakConcurrentTasks: null,
      taskCount: 38,
      failedTaskCount: 3,
    },
  ];

  const metric = (
    key: string,
    unit: string,
    mean: number | null,
    median: number | null,
    p90: number | null,
    availableCount: number,
  ): AggregateMetric => ({
    key,
    unit,
    mean,
    median,
    p90,
    availableCount,
    totalCount: timeline.length,
  });

  return {
    workflowName,
    versionName,
    window: { start, end, stepSeconds: 0 },
    runCount: timeline.length,
    succeeded: 2,
    failed: 1,
    cancelled: 0,
    collision: false,
    metrics: [
      metric('durationMs', 'ms', 1_100_000, 1_200_000, 1_500_000, 3),
      metric('meanCpu', 'vCPU', 2.35, 2.35, 2.6, 2),
      metric('peakCpu', 'vCPU', 3.9, 3.9, 4.0, 2),
      metric('meanMemoryGiB', 'GiB', 3.5, 3.5, 3.8, 2),
      metric('peakMemoryGiB', 'GiB', 5.95, 5.95, 6.0, 2),
      metric('cpuHours', 'CPU-hours', 1.65, 1.65, 1.9, 2),
      metric('peakConcurrentTasks', 'tasks', 13.5, 13.5, 15, 2),
      metric('taskCount', 'tasks', 39.67, 40, 41, 3),
      metric('failedTaskCount', 'tasks', 1.33, 1, 3, 3),
    ],
    // Fixed-size duration histogram (minutes shown; here in ms bounds).
    durationHistogram: {
      key: 'durationMs',
      unit: 'ms',
      availableCount: 3,
      totalCount: 3,
      buckets: [
        { lo: 600_000, hi: 900_000, count: 1 },
        { lo: 900_000, hi: 1_200_000, count: 1 },
        { lo: 1_200_000, hi: 1_500_000, count: 1 },
      ],
    },
    timeBins: [
      { start, end, runCount: 3, durationMeanMs: 1_100_000, durationP90Ms: 1_500_000 },
    ],
    sample: timeline,
    sampleCapped: false,
  };
}
