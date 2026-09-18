import { util } from '@aws-appsync/utils';

/**
 * listTasksForRun — Query all task items belonging to a run.
 *
 * Access pattern: Query PK = 'RUN#<runId>' with SK begins_with 'TASK#'
 * (Req 5.8). Returns the matched tasks, or an empty list when the run has no
 * tasks.
 */
export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: '#pk = :pk AND begins_with(#sk, :sk)',
      expressionNames: { '#pk': 'PK', '#sk': 'SK' },
      expressionValues: util.dynamodb.toMapValues({
        ':pk': `RUN#${ctx.args.runId}`,
        ':sk': 'TASK#',
      }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  // ctx.result.items is [] when the run has no tasks (Req 5.8).
  return ctx.result.items;
}
