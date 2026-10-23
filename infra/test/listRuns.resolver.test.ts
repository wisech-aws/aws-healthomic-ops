/**
 * Unit tests for the `listRuns` AppSync JS resolver (infra/resolvers/listRuns.js).
 *
 * The resolver runs in the APPSYNC_JS (ES6-subset) runtime in production, so it
 * imports `@aws-appsync/utils` — a module that is NOT installed here (it only
 * exists in the AppSync runtime). We mock it virtually so the request/response
 * logic can be exercised directly:
 *   - `util.dynamodb.toMapValues` is the identity, so a test can assert on the
 *     raw `:gsi1pk`/`:start`/`:end` value map the resolver assembles.
 *   - `util.error(message, type)` throws `"<type>:<message>"`, so a test can
 *     assert the BadRequest validation paths.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock(
  '@aws-appsync/utils',
  () => ({
    util: {
      dynamodb: {
        // Identity so tests assert on the raw value map the resolver builds.
        toMapValues: (map: Record<string, unknown>) => map,
      },
      error: (message: string, type?: string) => {
        throw new Error(`${type ?? 'Error'}:${message}`);
      },
    },
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { request, response } = require('../resolvers/listRuns.js') as {
  request: (ctx: { args: Record<string, unknown> }) => {
    operation: string;
    index: string;
    query: {
      expression: string;
      expressionNames: Record<string, string>;
      expressionValues: Record<string, unknown>;
    };
    projection: {
      expression: string;
      expressionNames: Record<string, string>;
    };
    scanIndexForward: boolean;
    limit: number;
    nextToken?: string;
  };
  response: (ctx: {
    error?: { message: string; type: string };
    result?: { items: unknown[]; nextToken?: string | null };
  }) => { items: unknown[]; nextToken?: string | null };
};

describe('listRuns resolver — request()', () => {
  it('no window: PK-only expression, default limit 25, descending', () => {
    const req = request({ args: {} });
    expect(req.operation).toBe('Query');
    expect(req.index).toBe('GSI1');
    expect(req.scanIndexForward).toBe(false);
    expect(req.limit).toBe(25);
    expect(req.query.expression).toBe('#gsi1pk = :gsi1pk');
    expect(req.query.expressionNames).toEqual({ '#gsi1pk': 'GSI1PK' });
    expect(req.query.expressionValues).toEqual({ ':gsi1pk': 'RUNS' });
  });

  it('both bounds: BETWEEN expression with GSI1SK name and :start/:end values', () => {
    const start = '2024-01-01T00:00:00.000Z';
    const end = '2024-01-31T23:59:59.999Z';
    const req = request({ args: { start, end } });
    expect(req.query.expression).toBe(
      '#gsi1pk = :gsi1pk AND #gsi1sk BETWEEN :start AND :end',
    );
    expect(req.query.expressionNames).toEqual({
      '#gsi1pk': 'GSI1PK',
      '#gsi1sk': 'GSI1SK',
    });
    expect(req.query.expressionValues).toEqual({
      ':gsi1pk': 'RUNS',
      ':start': start,
      ':end': end,
    });
    // Values are passed through as strings (toMapValues identity).
    expect(typeof req.query.expressionValues[':start']).toBe('string');
    expect(typeof req.query.expressionValues[':end']).toBe('string');
  });

  it('only start: >= expression, :end absent', () => {
    const start = '2024-01-01T00:00:00.000Z';
    const req = request({ args: { start } });
    expect(req.query.expression).toBe('#gsi1pk = :gsi1pk AND #gsi1sk >= :start');
    expect(req.query.expressionNames).toEqual({
      '#gsi1pk': 'GSI1PK',
      '#gsi1sk': 'GSI1SK',
    });
    expect(req.query.expressionValues).toEqual({
      ':gsi1pk': 'RUNS',
      ':start': start,
    });
    expect(req.query.expressionValues[':end']).toBeUndefined();
  });

  it('only end: <= expression, :start absent', () => {
    const end = '2024-01-31T23:59:59.999Z';
    const req = request({ args: { end } });
    expect(req.query.expression).toBe('#gsi1pk = :gsi1pk AND #gsi1sk <= :end');
    expect(req.query.expressionNames).toEqual({
      '#gsi1pk': 'GSI1PK',
      '#gsi1sk': 'GSI1SK',
    });
    expect(req.query.expressionValues).toEqual({
      ':gsi1pk': 'RUNS',
      ':end': end,
    });
    expect(req.query.expressionValues[':start']).toBeUndefined();
  });

  it('empty-string start -> BadRequest', () => {
    expect(() => request({ args: { start: '   ' } })).toThrow(/BadRequest:/);
  });

  it('non-string end -> BadRequest', () => {
    expect(() => request({ args: { end: 12345 } })).toThrow(/BadRequest:/);
  });

  it('passes nextToken through', () => {
    const req = request({ args: { nextToken: 'cursor-abc' } });
    expect(req.nextToken).toBe('cursor-abc');
  });

  it('limit validation unchanged: 0, 101, 1.5 -> BadRequest', () => {
    expect(() => request({ args: { limit: 0 } })).toThrow(/BadRequest:/);
    expect(() => request({ args: { limit: 101 } })).toThrow(/BadRequest:/);
    expect(() => request({ args: { limit: 1.5 } })).toThrow(/BadRequest:/);
  });

  it('limit=50 passes through; omitted defaults to 25', () => {
    expect(request({ args: { limit: 50 } }).limit).toBe(50);
    expect(request({ args: {} }).limit).toBe(25);
  });
});

/**
 * Field names of `type Run { ... }` in the GraphQL schema (comments stripped).
 * Parsed from the file so the drift guard follows the schema automatically.
 */
function schemaRunFields(): string[] {
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'graphql', 'schema.graphql'),
    'utf8',
  );
  const match = /^type Run\b[^{]*\{([\s\S]*?)^\}/m.exec(schema);
  if (match === null) {
    throw new Error('type Run not found in schema.graphql');
  }
  return match[1]
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const field = /^(\w+)\s*(\(|:)/.exec(line);
      if (field === null) {
        throw new Error(`unparseable Run field line: ${line}`);
      }
      return field[1];
    });
}

/** Attribute names the request's projection resolves to, in expression order. */
function projectedAttributes(req: ReturnType<typeof request>): string[] {
  const { expression, expressionNames } = req.projection;
  return expression.split(',').map((token) => {
    const placeholder = token.trim();
    const attribute = expressionNames[placeholder];
    if (attribute === undefined) {
      throw new Error(`projection placeholder ${placeholder} has no expression name`);
    }
    return attribute;
  });
}

describe('listRuns resolver — projection', () => {
  const windowArgs = {
    limit: 100,
    start: '2024-01-01T00:00:00.000Z',
    end: '2024-01-31T23:59:59.999Z',
    nextToken: 'cursor-abc',
  };

  it('drift guard: projected attributes equal the schema Run fields exactly', () => {
    const schemaFields = schemaRunFields();
    // Sanity: the parser found the full Run type, not a fragment.
    expect(schemaFields).toContain('runId');
    expect(schemaFields).toContain('failureReason');
    expect(schemaFields.length).toBeGreaterThanOrEqual(24);

    const projected = projectedAttributes(request({ args: windowArgs }));
    expect(new Set(projected).size).toBe(projected.length); // no duplicates
    expect([...projected].sort()).toEqual([...schemaFields].sort());
  });

  it('excludes rawGetRun, table/GSI keys and entityType', () => {
    const projected = projectedAttributes(request({ args: windowArgs }));
    for (const excluded of [
      'rawGetRun',
      'PK',
      'SK',
      'GSI1PK',
      'GSI1SK',
      'GSI2PK',
      'GSI2SK',
      'entityType',
    ]) {
      expect(projected).not.toContain(excluded);
    }
  });

  it('uses a placeholder for every attribute (reserved words like status/name)', () => {
    const { expression, expressionNames } = request({ args: windowArgs }).projection;
    for (const token of expression.split(',')) {
      expect(token.trim()).toMatch(/^#\w+$/);
    }
    expect(Object.values(expressionNames)).toEqual(
      expect.arrayContaining(['status', 'name']),
    );
    // Projection placeholders never collide with the key-condition names.
    const queryNames = request({ args: windowArgs }).query.expressionNames;
    for (const placeholder of Object.keys(expressionNames)) {
      expect(queryNames[placeholder]).toBeUndefined();
    }
  });

  it('projection is present for every window shape; pagination/limit unchanged', () => {
    for (const args of [
      {},
      { start: windowArgs.start },
      { end: windowArgs.end },
      windowArgs,
    ]) {
      const req = request({ args });
      expect(projectedAttributes(req).sort()).toEqual(schemaRunFields().sort());
      expect(req.scanIndexForward).toBe(false);
    }
    const req = request({ args: windowArgs });
    expect(req.limit).toBe(100);
    expect(req.nextToken).toBe('cursor-abc');
    expect(req.query.expression).toBe(
      '#gsi1pk = :gsi1pk AND #gsi1sk BETWEEN :start AND :end',
    );
  });
});

describe('listRuns resolver — response()', () => {
  it('surfaces ctx.error', () => {
    expect(() =>
      response({ error: { message: 'bad token', type: 'InvalidPagination' } }),
    ).toThrow('InvalidPagination:bad token');
  });

  it('returns items + nextToken from ctx.result', () => {
    const result = response({
      result: { items: [{ runId: 'r1' }], nextToken: 'next' },
    });
    expect(result).toEqual({ items: [{ runId: 'r1' }], nextToken: 'next' });
  });
});
