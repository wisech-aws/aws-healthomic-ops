import { util } from '@aws-appsync/utils';

/**
 * getRun — GetItem for a single run.
 *
 * Access pattern: GetItem PK = SK = 'RUN#<runId>' (Req 5.6). When no run
 * matches, GetItem returns no item and the resolver returns null WITHOUT
 * raising an error (Req 5.7).
 */
export function request(ctx) {
  const key = `RUN#${ctx.args.runId}`;
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ PK: key, SK: key }),
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  // ctx.result is null when no run matches — return it as-is (no error) so the
  // client receives a null run result (Req 5.7).
  return ctx.result;
}
