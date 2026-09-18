/**
 * In-memory sample data for LOCAL MOCK mode (see {@link isLocalMockMode}).
 *
 * These fixtures let the dashboard render a realistic fleet + run detail view
 * on a developer machine with no deployed backend and no signed-in Cognito
 * user. They are only referenced by the client's mock path and are never
 * bundled into a real deployment's data flow.
 */
import type { Run, Task } from './types';
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
