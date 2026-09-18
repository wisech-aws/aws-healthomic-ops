import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Verify LOCAL MOCK mode: the client serves in-memory sample data and no-op
// subscriptions WITHOUT configuring Amplify (so there is no auth / "No
// federated jwt" path). We force mock mode by stubbing import.meta.env before
// importing the client module fresh.

describe('client in local mock mode (VITE_LOCAL_MOCK=true)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_LOCAL_MOCK', 'true');
    // Amplify must never be configured in mock mode; fail loudly if it is.
    vi.doMock('aws-amplify', () => ({
      Amplify: {
        configure: () => {
          throw new Error('Amplify.configure must not run in local mock mode');
        },
      },
    }));
    vi.doMock('aws-amplify/api', () => ({
      generateClient: () => {
        throw new Error('generateClient must not run in local mock mode');
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('aws-amplify');
    vi.doUnmock('aws-amplify/api');
  });

  it('listRuns returns sample runs without touching Amplify', async () => {
    const { listRuns } = await import('./client');
    const connection = await listRuns();
    expect(connection.items.length).toBeGreaterThan(0);
    expect(connection.nextToken).toBeNull();
  });

  it('getRun returns a matching sample run or null', async () => {
    const { listRuns, getRun } = await import('./client');
    const first = (await listRuns()).items[0];
    expect(await getRun(first.runId)).toEqual(first);
    expect(await getRun('does-not-exist')).toBeNull();
  });

  it('listTasksForRun returns sample tasks (empty for an unknown run)', async () => {
    const { listTasksForRun } = await import('./client');
    expect(await listTasksForRun('run-1001')).not.toHaveLength(0);
    expect(await listTasksForRun('unknown')).toEqual([]);
  });

  it('subscriptions are inert no-ops that never open a socket', async () => {
    const { onRunUpdated, onTaskUpdated } = await import('./client');
    const runSub = onRunUpdated({ next: () => {} });
    const taskSub = onTaskUpdated('run-1001', { next: () => {} });
    // unsubscribe is safe to call and does nothing.
    expect(() => runSub.unsubscribe()).not.toThrow();
    expect(() => taskSub.unsubscribe()).not.toThrow();
  });
});
