import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse, Kind } from 'graphql';
import type { FieldNode, OperationDefinitionNode, SelectionSetNode } from 'graphql';

// The fleet's `listRuns` document must select every field the fleet reads
// (columns, ordering, staleness, duration, filters, search, grouping) and none
// of the heavy detail fields, which the detail/compare views get via getRun.

/** Fields the fleet reads anywhere (FleetView + fleet/*.ts helpers). */
const FLEET_FIELDS = [
  'runId',
  'status',
  'name',
  'startedAt',
  'stoppedAt',
  'updatedAt',
  'workflowId',
  'workflowName',
  'workflowVersionName',
  'engineVersion',
  'batchId',
];

/** Detail-only fields the fleet never reads; must not be selected. */
const DETAIL_ONLY_FIELDS = [
  'parameters',
  'tags',
  'outputUri',
  'storageType',
  'storageCapacity',
  'cacheId',
  'cacheBehavior',
  'networkingMode',
  'configurationName',
  'logLevel',
  'statusMessage',
  'failureReason',
  'createdAt',
];

function fieldNames(selectionSet: SelectionSetNode | undefined): string[] {
  return (selectionSet?.selections ?? [])
    .filter((s): s is FieldNode => s.kind === Kind.FIELD)
    .map((s) => s.name.value);
}

function childField(selectionSet: SelectionSetNode | undefined, name: string): FieldNode {
  const field = (selectionSet?.selections ?? []).find(
    (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === name,
  );
  if (field === undefined) {
    throw new Error(`field ${name} not selected`);
  }
  return field;
}

/** The field names selected under `listRuns { items { ... } }`. */
function listRunsItemFields(document: string): string[] {
  const op = parse(document).definitions[0] as OperationDefinitionNode;
  const listRuns = childField(op.selectionSet, 'listRuns');
  expect(fieldNames(listRuns.selectionSet)).toContain('nextToken');
  return fieldNames(childField(listRuns.selectionSet, 'items').selectionSet);
}

describe('LIST_RUNS (fleet selection set)', () => {
  it('selects exactly the fields the fleet reads', async () => {
    const { LIST_RUNS } = await import('./client');
    const selected = listRunsItemFields(LIST_RUNS);
    expect([...selected].sort()).toEqual([...FLEET_FIELDS].sort());
  });

  it('does not select heavy detail-only fields', async () => {
    const { LIST_RUNS } = await import('./client');
    const selected = listRunsItemFields(LIST_RUNS);
    for (const field of DETAIL_ONLY_FIELDS) {
      expect(selected).not.toContain(field);
    }
  });
});

describe('listRuns() sends the slim fleet document', () => {
  const graphql = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    graphql.mockReset();
    graphql.mockResolvedValue({ data: { listRuns: { items: [], nextToken: null } } });
    vi.stubEnv('VITE_LOCAL_MOCK', 'false');
    vi.stubEnv('VITE_APPSYNC_ENDPOINT', 'https://example.invalid/graphql');
    vi.stubEnv('VITE_USER_POOL_ID', 'us-east-1_example');
    vi.stubEnv('VITE_USER_POOL_CLIENT_ID', 'exampleclientid');
    vi.stubEnv('VITE_AWS_REGION', 'us-east-1');
    vi.doMock('aws-amplify', () => ({ Amplify: { configure: () => {} } }));
    vi.doMock('aws-amplify/api', () => ({ generateClient: () => ({ graphql }) }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('aws-amplify');
    vi.doUnmock('aws-amplify/api');
  });

  it('passes LIST_RUNS and the window variables to the GraphQL client', async () => {
    const { listRuns, LIST_RUNS } = await import('./client');
    const variables = {
      limit: 100,
      start: '2026-09-23T00:00:00.000Z',
      end: '2026-10-23T00:00:00.000Z',
    };
    await listRuns(variables);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql).toHaveBeenCalledWith({ query: LIST_RUNS, variables });
  });
});
