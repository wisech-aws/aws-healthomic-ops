import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` factories and `vi.hoisted` run before the module-under-test is
// imported. `costHandler.ts` reads COST_REGION / COST_TABLE_NAME into
// module-level consts and constructs its AWS clients at import time, so the env
// MUST be set inside `vi.hoisted` (before the static `import` below), and the
// shared mock refs must likewise be created here so the `vi.mock` factories can
// close over them.
const { omicsSendMock, docSendMock, loadRateCardMock, fetchRunFilesystemUsageMock } = vi.hoisted(
  () => {
    process.env.COST_TABLE_NAME = 'cost-table';
    process.env.COST_REGION = 'us-east-1';
    return {
      omicsSendMock: vi.fn(),
      docSendMock: vi.fn(),
      loadRateCardMock: vi.fn(),
      fetchRunFilesystemUsageMock: vi.fn(),
    };
  },
);

vi.mock('@aws-sdk/client-omics', () => {
  class OmicsClient {
    send = omicsSendMock;
  }
  class GetRunCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  return { OmicsClient, GetRunCommand };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {}
  return { DynamoDBClient };
});

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const DynamoDBDocumentClient = {
    from: () => ({ send: docSendMock }),
  };
  class QueryCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  return { DynamoDBDocumentClient, QueryCommand };
});

// Price List fetcher: only referenced by the handler to hand to `loadRateCard`,
// which is itself mocked, so a no-op stub keeps the real pricing client out.
vi.mock('../src/cost/priceList.js', () => ({
  fetchRateMap: vi.fn(),
}));

vi.mock('../src/cost/rateCard.js', () => ({
  loadRateCard: loadRateCardMock,
}));

vi.mock('../src/cost/filesystemUsage.js', () => ({
  fetchRunFilesystemUsage: fetchRunFilesystemUsageMock,
}));

import { handler, type RunCostEstimate } from '../src/costHandler.js';

function makeEvent(runId: string) {
  return { arguments: { runId } } as never;
}

/** A rate map with a compute rate so the happy path yields an available compute line item. */
const OK_RATE_CARD = {
  status: 'ok' as const,
  rates: {
    'omics.m.large': { pricePerUnit: 0.1, unit: 'Instance-hrs' },
    'Run Storage': { pricePerUnit: 0.0001, unit: 'GB-Hours' },
  },
  currency: 'USD',
  effectiveDate: '2024-01-01',
  stale: false,
};

/** A single successful GetRun with a STATIC storage type and a closed window. */
function okGetRun() {
  return {
    startTime: new Date('2024-01-01T00:00:00Z'),
    stopTime: new Date('2024-01-01T02:00:00Z'),
    storageType: 'STATIC',
    storageCapacity: 100,
  };
}

/** One task page (no LastEvaluatedKey => single page). */
function oneTaskPage() {
  return {
    Items: [
      {
        instanceType: 'omics.m.large',
        startedAt: '2024-01-01T00:00:00Z',
        stoppedAt: '2024-01-01T01:00:00Z',
      },
    ],
    LastEvaluatedKey: undefined,
  };
}

describe('costHandler getRunCostEstimate', () => {
  beforeEach(() => {
    omicsSendMock.mockReset();
    docSendMock.mockReset();
    loadRateCardMock.mockReset();
    fetchRunFilesystemUsageMock.mockReset();
  });

  it('throws when runId is empty (the only throw path)', async () => {
    await expect(handler(makeEvent(''))).rejects.toThrow(/runId is required/i);
    await expect(handler(makeEvent('   '))).rejects.toThrow(/runId is required/i);
    // Validation happens before any orchestration I/O.
    expect(omicsSendMock).not.toHaveBeenCalled();
    expect(docSendMock).not.toHaveBeenCalled();
  });

  it('returns a typed error result (not a throw) when GetRun fails', async () => {
    omicsSendMock.mockRejectedValue(new Error('omics unavailable'));

    const res: RunCostEstimate = await handler(makeEvent('r1'));

    expect(res.error).not.toBeNull();
    expect(res.error).toMatch(/GetRun failed/i);
    expect(res.lineItems).toEqual([]);
    expect(res.total).toBeNull();
    expect(res.partial).toBe(false);
    // A GetRun failure short-circuits before the task query.
    expect(docSendMock).not.toHaveBeenCalled();
  });

  it('returns a typed error result when the task Query throws — NOT an empty-tasks success', async () => {
    omicsSendMock.mockResolvedValue(okGetRun());
    docSendMock.mockRejectedValue(new Error('DynamoDB Query timed out'));

    const res: RunCostEstimate = await handler(makeEvent('r1'));

    // A broken task query is a genuine read failure, so `error` is set — it must
    // NOT be conflated with a run that legitimately has zero tasks.
    expect(res.error).not.toBeNull();
    expect(res.error).toMatch(/Failed to load tasks/i);
    expect(res.lineItems).toEqual([]);
    expect(res.total).toBeNull();
    expect(res.partial).toBe(false);
  });

  it('returns a populated estimate (error === null) on the happy path', async () => {
    omicsSendMock.mockResolvedValue(okGetRun());
    docSendMock.mockResolvedValue(oneTaskPage());
    loadRateCardMock.mockResolvedValue(OK_RATE_CARD);

    const res: RunCostEstimate = await handler(makeEvent('r1'));

    expect(res.error).toBeNull();
    expect(res.currency).toBe('USD');
    expect(res.effectiveDate).toBe('2024-01-01');
    expect(res.lineItems.length).toBeGreaterThan(0);

    const compute = res.lineItems.find(
      (item) => item.category === 'COMPUTE' && item.resourceType === 'omics.m.large',
    );
    expect(compute).toBeDefined();
    expect(compute?.available).toBe(true);
    // 1 hour at $0.10/hr.
    expect(compute?.quantity).toBeCloseTo(1);
    expect(compute?.ratePerUnit).toBe(0.1);
    expect(compute?.estimatedCost).toBeCloseTo(0.1);
    expect(res.total).not.toBeNull();
  });

  it('degrades to unavailable line items (error === null) when loadRateCard reports unavailable', async () => {
    omicsSendMock.mockResolvedValue(okGetRun());
    docSendMock.mockResolvedValue(oneTaskPage());
    // Price List failed AND no cached card => typed unavailable sentinel.
    loadRateCardMock.mockResolvedValue({ status: 'unavailable', reason: 'price list down' });

    const res: RunCostEstimate = await handler(makeEvent('r1'));

    // This is NOT a hard error: the estimate still resolves, just with no rates.
    expect(res.error).toBeNull();
    expect(res.currency).toBeNull();
    expect(res.effectiveDate).toBeNull();
    expect(res.lineItems.length).toBeGreaterThan(0);
    expect(res.lineItems.every((item) => item.available === false)).toBe(true);
    expect(res.partial).toBe(true);
    expect(res.total).toBeNull();
  });

  it('degrades to unavailable rates (error === null) when loadRateCard itself throws', async () => {
    omicsSendMock.mockResolvedValue(okGetRun());
    docSendMock.mockResolvedValue(oneTaskPage());
    // An unexpected throw from the rate-card load (e.g. its cache read/write) must
    // NOT fail the estimate — it degrades to an unavailable rate map.
    loadRateCardMock.mockRejectedValue(new Error('rate-card cache read failed'));

    const res: RunCostEstimate = await handler(makeEvent('r1'));

    expect(res.error).toBeNull();
    expect(res.currency).toBeNull();
    expect(res.lineItems.every((item) => item.available === false)).toBe(true);
  });
});
