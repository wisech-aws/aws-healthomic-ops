import { util } from '@aws-appsync/utils';

/**
 * getStaticGraph — GetItem for a source-derived static DAG.
 *
 * Access pattern: GetItem PK = SK = 'WF#<workflowId>#<workflowVersionName>'
 * (Req 6.3), built from ctx.args.workflowId + ctx.args.workflowVersionName.
 * Returns null WITHOUT raising an error when no item matches OR when the item
 * is a failure-only marker with no graph (no `nodes`) — treated as a cache
 * miss by the client (Req 6.5). A usable item is projected to the StaticGraph
 * shape, defaulting a legacy item lacking `fidelity` to 'approximate' (Req 6.4).
 */
export function request(ctx) {
  const key = `WF#${ctx.args.workflowId}#${ctx.args.workflowVersionName}`;
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ PK: key, SK: key }),
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  const item = ctx.result;
  // No item, or a failure-only marker (no nodes) -> null (Req 6.5).
  if (!item || !item.nodes) {
    return null;
  }
  return {
    workflowId: item.workflowId,
    nodes: item.nodes,
    edges: item.edges,
    fidelity: item.fidelity || 'approximate',
  };
}
