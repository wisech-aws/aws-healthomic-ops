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
  const { limit, nextToken, start, end } = ctx.args;

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

  // Optional time window on `updatedAt` (= GSI1SK). `start`/`end` are inclusive
  // ISO-8601 UTC bounds. Each supplied bound must be a non-empty string; the
  // client sends canonical ISO instants (same contract as the limit note on the
  // runtime subset — no `Date`/regex parsing here, only typeof + a trim check,
  // both of which the APPSYNC_JS runtime supports).
  const hasStart = start !== null && start !== undefined;
  const hasEnd = end !== null && end !== undefined;
  if (hasStart && (typeof start !== 'string' || start.trim() === '')) {
    util.error('start must be a non-empty ISO-8601 string', 'BadRequest');
  }
  if (hasEnd && (typeof end !== 'string' || end.trim() === '')) {
    util.error('end must be a non-empty ISO-8601 string', 'BadRequest');
  }

  // Assemble the key-condition expression from whichever bounds are present.
  // Base is the PK-only query (unchanged legacy behavior when no window is
  // given); the `#gsi1sk` expression name is added only when a bound is used so
  // DynamoDB never sees an unused expression attribute name.
  //   both  -> #gsi1pk = :gsi1pk AND #gsi1sk BETWEEN :start AND :end
  //   start -> #gsi1pk = :gsi1pk AND #gsi1sk >= :start
  //   end   -> #gsi1pk = :gsi1pk AND #gsi1sk <= :end
  //   none  -> #gsi1pk = :gsi1pk
  let expression = '#gsi1pk = :gsi1pk';
  const expressionNames = { '#gsi1pk': 'GSI1PK' };
  const rawValues = { ':gsi1pk': 'RUNS' };
  if (hasStart && hasEnd) {
    expression = '#gsi1pk = :gsi1pk AND #gsi1sk BETWEEN :start AND :end';
    expressionNames['#gsi1sk'] = 'GSI1SK';
    rawValues[':start'] = start;
    rawValues[':end'] = end;
  } else if (hasStart) {
    expression = '#gsi1pk = :gsi1pk AND #gsi1sk >= :start';
    expressionNames['#gsi1sk'] = 'GSI1SK';
    rawValues[':start'] = start;
  } else if (hasEnd) {
    expression = '#gsi1pk = :gsi1pk AND #gsi1sk <= :end';
    expressionNames['#gsi1sk'] = 'GSI1SK';
    rawValues[':end'] = end;
  }

  return {
    operation: 'Query',
    index: 'GSI1',
    query: {
      expression: expression,
      expressionNames: expressionNames,
      expressionValues: util.dynamodb.toMapValues(rawValues),
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
