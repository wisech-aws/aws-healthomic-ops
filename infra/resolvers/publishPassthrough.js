/**
 * publishPassthrough — pass-through resolver for the publish mutations.
 *
 * publishRunUpdate / publishTaskUpdate exist solely to trigger subscription
 * fan-out. The ingest Lambda has already written the run/task to DynamoDB
 * before calling the mutation (write-then-publish ordering), so these resolvers
 * do no data-source work: they echo back the mutation input so @aws_subscribe
 * delivers it to onRunUpdated / onTaskUpdated subscribers (Req 4.5, 4.6).
 *
 * Backed by a NONE (local) data source — no DynamoDB round-trip.
 */
export function request(ctx) {
  return { payload: ctx.args.input };
}

export function response(ctx) {
  return ctx.result;
}
