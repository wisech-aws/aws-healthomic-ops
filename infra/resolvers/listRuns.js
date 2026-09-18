import { util } from '@aws-appsync/utils';

/**
 * listRuns — Query GSI1 for all runs ordered by descending updatedAt.
 *
 * Access pattern: Query GSI1 where GSI1PK = 'RUNS', ScanIndexForward = false
 * so the newest run (largest GSI1SK / updatedAt) comes first (Req 5.2, 8.4).
 *
 * `limit` is validated server-side: an integer 1–100, defaulting to 25 when
 * omitted (Req 5.2). Out-of-range values are rejected without returning data
 * (Req 5.3). `nextToken` continues a prior page (Req 5.4); a malformed or
 * expired token is surfaced as an error by DynamoDB (Req 5.5).
 */
const DEFAULT_LIMIT = 25;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

export function request(ctx) {
  const { limit, nextToken } = ctx.args;

  // Default when omitted (null/undefined); otherwise validate the supplied
  // value is an integer within [1, 100] (Req 5.2, 5.3).
  //
  // NOTE: the APPSYNC_JS runtime is an ES6 subset and does not support
  // `Number.isInteger` (using it fails schema/resolver validation at deploy
  // time). Integer-ness is checked with `Math.floor` + a self-equality NaN
  // guard, both of which the runtime supports.
  let effectiveLimit = DEFAULT_LIMIT;
  if (limit !== null && limit !== undefined) {
    const isInteger =
      typeof limit === 'number' && limit === limit && Math.floor(limit) === limit;
    if (!isInteger || limit < MIN_LIMIT || limit > MAX_LIMIT) {
      util.error(
        `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
        'BadRequest',
      );
    }
    effectiveLimit = limit;
  }

  return {
    operation: 'Query',
    index: 'GSI1',
    query: {
      expression: '#gsi1pk = :gsi1pk',
      expressionNames: { '#gsi1pk': 'GSI1PK' },
      expressionValues: util.dynamodb.toMapValues({ ':gsi1pk': 'RUNS' }),
    },
    scanIndexForward: false,
    limit: effectiveLimit,
    nextToken: nextToken,
  };
}

export function response(ctx) {
  // A malformed or expired nextToken produces a DynamoDB error; surface it so
  // the client sees an invalid-pagination-token error rather than run data
  // (Req 5.5).
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  // Return the page and the continuation token (null when no further pages
  // exist) (Req 5.4).
  return {
    items: ctx.result.items,
    nextToken: ctx.result.nextToken,
  };
}
