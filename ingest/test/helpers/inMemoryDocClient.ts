/**
 * In-memory DynamoDB document-client double shared by the repository, handler
 * and replay tests.
 *
 * It evaluates the command shapes `DynamoRepository` issues for run/task/summary
 * persistence and the caches:
 *   - `UpdateCommand` with a `SET #a = :a, ...` expression, applied as a MERGE
 *     over the stored item. When a `ConditionExpression` is present it is the
 *     repository's monotonic guard (`attribute_not_exists(PK) OR (...)`), which
 *     is evaluated faithfully: terminal-wins, no-revert, and strictly-newer
 *     `updatedAt`. A failed condition throws `ConditionalCheckFailedException`.
 *     `ReturnValues: 'ALL_NEW'` returns the merged item as `Attributes`.
 *   - `PutCommand` (full replace), `GetCommand` (optionally projected), and a
 *     `QueryCommand` for `PK = :pk AND begins_with(SK, :prefix)`.
 *
 * An optional fault injector lets tests simulate transient failures for the
 * retry behavior (Req 3.10). This is a real evaluation of the write semantics,
 * not a mock that rubber-stamps success.
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'DELETED']);

type Item = Record<string, unknown>;

export class InMemoryDocClient {
  readonly store = new Map<string, Item>();
  sendCount = 0;

  /**
   * When set, invoked before each command with the current attempt number
   * (1-based). Return an Error to make that attempt fail transiently, or
   * undefined to let it proceed.
   */
  failNext?: (attempt: number) => Error | undefined;
  private attempt = 0;

  private keyOf(key: Item): string {
    return `${String(key.PK)}|${String(key.SK)}`;
  }

  async send(command: unknown): Promise<unknown> {
    this.sendCount += 1;
    this.attempt += 1;

    if (this.failNext) {
      const injected = this.failNext(this.attempt);
      if (injected) {
        throw injected;
      }
    }

    if (command instanceof PutCommand) {
      const item = command.input.Item as Item;
      this.store.set(this.keyOf(item), { ...item });
      return {};
    }

    if (command instanceof GetCommand) {
      const existing = this.store.get(this.keyOf(command.input.Key as Item));
      if (existing === undefined) {
        return {};
      }
      const projection = command.input.ProjectionExpression;
      if (projection === undefined) {
        return { Item: { ...existing } };
      }
      const names = command.input.ExpressionAttributeNames ?? {};
      const projected: Item = {};
      for (const token of projection.split(',').map((t) => t.trim())) {
        const attr = names[token] ?? token;
        if (attr in existing) {
          projected[attr] = existing[attr];
        }
      }
      return { Item: projected };
    }

    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues ?? {};
      const pk = String(values[':pk']);
      const prefix = String(
        Object.entries(values).find(([k]) => k !== ':pk')?.[1] ?? '',
      );
      const items = [...this.store.values()]
        .filter((it) => it.PK === pk && String(it.SK).startsWith(prefix))
        .map((it) => ({ ...it }));
      return { Items: items };
    }

    if (command instanceof UpdateCommand) {
      return this.update(command);
    }

    throw new Error('Unsupported command in InMemoryDocClient');
  }

  private update(command: UpdateCommand): unknown {
    const input = command.input;
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const key = this.keyOf(input.Key as Item);
    const existing = this.store.get(key);

    // Rebuild {attr: value} from the SET clause plus the key.
    const incoming: Item = { ...(input.Key as Item) };
    const setClause = (input.UpdateExpression ?? '').replace(/^SET\s+/i, '');
    for (const assignment of setClause.split(',')) {
      const [lhs, rhs] = assignment.split('=').map((s) => s.trim());
      if (lhs === undefined || rhs === undefined) continue;
      incoming[names[lhs] ?? lhs] = values[rhs];
    }

    if (input.ConditionExpression !== undefined && existing !== undefined) {
      // Faithfully evaluate the repository's guard:
      //   attribute_not_exists(PK) OR (statusClause)
      const incomingUpdatedAt = values[':incomingUpdatedAt'] as string | undefined;
      const monotonic =
        incomingUpdatedAt !== undefined &&
        typeof existing.updatedAt === 'string' &&
        incomingUpdatedAt > existing.updatedAt;
      const incomingIsTerminal = values[':incomingIsTerminal'] as boolean | undefined;
      let conditionMet: boolean;
      if (incomingIsTerminal === undefined) {
        conditionMet = monotonic;
      } else {
        const storedHasStatus = typeof existing.status === 'string';
        const storedIsTerminal =
          storedHasStatus && TERMINAL.has(existing.status as string);
        const terminalWins = incomingIsTerminal && storedHasStatus && !storedIsTerminal;
        const noRevert = incomingIsTerminal || !storedHasStatus || !storedIsTerminal;
        conditionMet = terminalWins || (monotonic && noRevert);
      }
      if (!conditionMet) {
        throw new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        });
      }
    }

    const merged = { ...(existing ?? {}), ...incoming };
    this.store.set(key, merged);
    return input.ReturnValues === 'ALL_NEW' ? { Attributes: { ...merged } } : {};
  }

  /** Reset the per-instance transient-failure attempt counter. */
  resetAttempts(): void {
    this.attempt = 0;
  }

  asDocClient(): DynamoDBDocumentClient {
    return this as unknown as DynamoDBDocumentClient;
  }
}
