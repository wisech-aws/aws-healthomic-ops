/**
 * Publisher: pushes persisted run/task changes to the AppSync GraphQL API so
 * subscribed clients receive live updates (Requirement 4).
 *
 * After the ingest Lambda has persisted a run or task change (write-then-publish
 * ordering, design.md "Ingest Lambda Design" step 5), it calls
 * {@link AppSyncPublisher.publishRunUpdate} / {@link AppSyncPublisher.publishTaskUpdate}.
 * Each call:
 *
 *   - Rejects a change whose `runId` (run) or `runId`/`taskId` (task) is missing
 *     or empty BEFORE any network call, recording an error identifying the
 *     invalid identifier (Req 4.9).
 *   - Maps the domain {@link RunRecord}/{@link TaskRecord} to the GraphQL
 *     `RunInput`/`TaskInput` variables (design.md "GraphQL API").
 *   - Signs the mutation request with AWS SigV4 IAM credentials and POSTs it to
 *     the AppSync HTTPS endpoint (Req 4.3).
 *   - Retries a failed mutation up to {@link MAX_PUBLISH_ATTEMPTS} attempts; if
 *     every attempt fails it records/returns an error describing the publish
 *     failure while the already-persisted data is retained unchanged — it does
 *     NOT throw, so the caller can log and move on without discarding persisted
 *     state (Req 4.8).
 *
 * The AppSync endpoint URL and AWS region are read from environment variables
 * (`APPSYNC_ENDPOINT`, `AWS_REGION`). AppSync's GraphQL data-plane service name
 * for SigV4 signing is `appsync`.
 *
 * Only Node's built-in `crypto` (for the SigV4 payload/HMAC hash) and global
 * `fetch` are used for transport, plus `@smithy/signature-v4` and
 * `@aws-sdk/credential-provider-node`; no additional crypto dependency is
 * required.
 */

import { createHash, createHmac } from 'node:crypto';

import { SignatureV4 } from '@smithy/signature-v4';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

import type { RunRecord, TaskRecord } from './domain/records.js';

/**
 * Maximum number of publish attempts for a single mutation before giving up and
 * recording a publish failure (Req 4.8). Three total attempts = the initial
 * call plus up to two retries.
 */
export const MAX_PUBLISH_ATTEMPTS = 3;

/** The AppSync SigV4 signing service name for the GraphQL data plane. */
const APPSYNC_SERVICE = 'appsync';

/**
 * A minimal `Hash` implementation backed by Node's built-in `crypto`, satisfying
 * the `HashConstructor` interface `@smithy/signature-v4` expects for its
 * `sha256` option. When constructed with a secret it computes an HMAC-SHA256
 * (used to derive the SigV4 signing key); without a secret it computes a plain
 * SHA-256 (used for the canonical-request payload hash). This keeps SigV4
 * signing dependency-free rather than pulling in `@aws-crypto/sha256-js`.
 */
class Sha256 {
  private readonly hash: import('node:crypto').Hash | import('node:crypto').Hmac;

  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash =
      secret !== undefined
        ? createHmac('sha256', toBinary(secret))
        : createHash('sha256');
  }

  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(toBinary(data));
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

/**
 * Coerce the `SourceData` shapes SigV4 passes (string, ArrayBuffer, or
 * ArrayBufferView) into a Node `Buffer` for `crypto` update. Strings are treated
 * as UTF-8, matching the `Hash` contract.
 */
function toBinary(data: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

/**
 * The GraphQL `RunInput` variables shape (design.md "GraphQL API"). Optional
 * fields are omitted when the record does not carry them so the mutation only
 * sends known values.
 */
export interface RunInput {
  runId: string;
  status?: string;
  name?: string;
  createdAt?: string;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
  workflowId?: string;
  workflowName?: string;
  workflowVersionName?: string;
  outputUri?: string;
  /** JSON-stringified run parameters (AWSJSON accepts a JSON string). */
  parameters?: string;
  engineVersion?: string;
  roleArn?: string;
  storageType?: string;
  storageCapacity?: number;
  cacheId?: string;
  cacheBehavior?: string;
  networkingMode?: string;
  configurationName?: string;
  logLevel?: string;
  batchId?: string;
  /** JSON-stringified string->string tag map (AWSJSON accepts a JSON string). */
  tags?: string;
  /** Human-readable status detail, e.g. why a run failed. */
  statusMessage?: string;
  /** Machine-readable failure reason, e.g. "WORKFLOW_RUN_FAILED". */
  failureReason?: string;
}

/**
 * The GraphQL `TaskInput` variables shape (design.md "GraphQL API"). Optional
 * fields are omitted when the record does not carry them.
 */
export interface TaskInput {
  runId: string;
  taskId: string;
  status?: string;
  name?: string;
  createdAt?: string;
  startedAt?: string;
  stoppedAt?: string;
  updatedAt: string;
  cpus?: number;
  memory?: number;
  /** The compute (instance) type the task ran on, e.g. "omics.c.large". */
  instanceType?: string;
  /** Human-readable status detail, e.g. why a task failed. */
  statusMessage?: string;
  /** Machine-readable failure reason, e.g. "RUN_TASK_FAILED". */
  failureReason?: string;
}

/**
 * The outcome of a publish call.
 *
 * - `published` — the mutation succeeded.
 * - `rejected`  — the change was rejected before any network call because a
 *   required identifier was missing/empty (Req 4.9). `error` names the offense.
 * - `failed`    — every attempt failed; the persisted data is retained
 *   unchanged and `error` carries the last transport failure (Req 4.8).
 *
 * Publishing never throws for `rejected`/`failed`; the caller inspects
 * `outcome` and logs accordingly.
 */
export type PublishResult =
  | { outcome: 'published' }
  | { outcome: 'rejected'; error: InvalidPublishIdentifierError }
  | { outcome: 'failed'; error: PublishFailedError };

/**
 * Error describing a publish rejected before the mutation call because a
 * required identifier was missing or empty (Req 4.9).
 */
export class InvalidPublishIdentifierError extends Error {
  constructor(
    /** Which mutation was being attempted. */
    public readonly mutation: 'publishRunUpdate' | 'publishTaskUpdate',
    /** The name of the missing/empty identifier attribute. */
    public readonly attribute: 'runId' | 'taskId',
  ) {
    super(
      `Rejected ${mutation}: required identifier "${attribute}" is missing or empty`,
    );
    this.name = 'InvalidPublishIdentifierError';
  }
}

/**
 * Error describing a publish that failed after {@link MAX_PUBLISH_ATTEMPTS}
 * attempts. The already-persisted run/task data is retained unchanged (Req 4.8);
 * this error exists so the handler can log the publish failure and the affected
 * identifier.
 */
export class PublishFailedError extends Error {
  constructor(
    public readonly mutation: 'publishRunUpdate' | 'publishTaskUpdate',
    /** The affected run/task identifier for log correlation. */
    public readonly identifier: string,
    /** The last underlying transport failure. */
    public readonly cause: unknown,
  ) {
    super(
      `${mutation}(${identifier}) failed after ${MAX_PUBLISH_ATTEMPTS} attempts; ` +
        `persisted data retained unchanged`,
    );
    this.name = 'PublishFailedError';
  }
}

/**
 * Injectable HTTP transport. Defaults to global `fetch`; overridden in tests to
 * mock the network without touching AppSync. The publisher only needs the
 * request URL, headers, and body plus the response status/text.
 */
export type HttpTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

const defaultTransport: HttpTransport = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: () => response.text() };
};

/** Options for constructing an {@link AppSyncPublisher}. */
export interface AppSyncPublisherOptions {
  /** AppSync GraphQL endpoint URL. Defaults to `process.env.APPSYNC_ENDPOINT`. */
  endpoint?: string;
  /** AWS region. Defaults to `process.env.AWS_REGION`. */
  region?: string;
  /** IAM credentials provider. Defaults to the standard Node provider chain (Req 4.3). */
  credentials?: AwsCredentialIdentityProvider;
  /** HTTP transport. Defaults to global `fetch`. Injected in tests. */
  transport?: HttpTransport;
  /** Max publish attempts. Defaults to {@link MAX_PUBLISH_ATTEMPTS}. Lowered in tests only. */
  maxAttempts?: number;
  /** Log sink for publish failures; defaults to `console.error`. Injected in tests. */
  logger?: (message: string, error?: unknown) => void;
}

/** The GraphQL mutation documents. Return the input payload for subscription fan-out. */
const RUN_MUTATION = `mutation PublishRunUpdate($input: RunInput!) {
  publishRunUpdate(input: $input) {
    runId status name createdAt startedAt stoppedAt updatedAt workflowId workflowName workflowVersionName outputUri parameters engineVersion roleArn storageType storageCapacity cacheId cacheBehavior networkingMode configurationName logLevel batchId tags statusMessage failureReason
  }
}`;

const TASK_MUTATION = `mutation PublishTaskUpdate($input: TaskInput!) {
  publishTaskUpdate(input: $input) {
    runId taskId status name createdAt startedAt stoppedAt updatedAt cpus memory instanceType statusMessage failureReason
  }
}`;

/**
 * Assign `value` to `target[key]` only when it is defined, so the GraphQL input
 * only carries known fields (mirrors the repository's item building).
 */
function setIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/** Map a {@link RunRecord} to the GraphQL `RunInput` variables. */
export function toRunInput(run: RunRecord): RunInput {
  const input: RunInput = { runId: run.runId, updatedAt: run.updatedAt };
  setIfDefined(input, 'status', run.status as string | undefined);
  setIfDefined(input, 'name', run.name);
  setIfDefined(input, 'createdAt', run.createdAt);
  setIfDefined(input, 'startedAt', run.startedAt);
  setIfDefined(input, 'stoppedAt', run.stoppedAt);
  setIfDefined(input, 'workflowId', run.workflowId);
  setIfDefined(input, 'workflowName', run.workflowName);
  setIfDefined(input, 'workflowVersionName', run.workflowVersionName);
  setIfDefined(input, 'outputUri', run.outputUri);
  setIfDefined(input, 'parameters', run.parameters);
  setIfDefined(input, 'engineVersion', run.engineVersion);
  setIfDefined(input, 'roleArn', run.roleArn);
  setIfDefined(input, 'storageType', run.storageType);
  setIfDefined(input, 'storageCapacity', run.storageCapacity);
  setIfDefined(input, 'cacheId', run.cacheId);
  setIfDefined(input, 'cacheBehavior', run.cacheBehavior);
  setIfDefined(input, 'networkingMode', run.networkingMode);
  setIfDefined(input, 'configurationName', run.configurationName);
  setIfDefined(input, 'logLevel', run.logLevel);
  setIfDefined(input, 'batchId', run.batchId);
  setIfDefined(input, 'tags', run.tags);
  setIfDefined(input, 'statusMessage', run.statusMessage);
  setIfDefined(input, 'failureReason', run.failureReason);
  // Note: `rawGetRun` is intentionally NOT published — it is a server-side
  // audit capture persisted in DynamoDB only, not exposed via the GraphQL API.
  return input;
}

/** Map a {@link TaskRecord} to the GraphQL `TaskInput` variables. */
export function toTaskInput(task: TaskRecord): TaskInput {
  const input: TaskInput = {
    runId: task.runId,
    taskId: task.taskId,
    updatedAt: task.updatedAt,
  };
  setIfDefined(input, 'status', task.status as string | undefined);
  setIfDefined(input, 'name', task.name);
  setIfDefined(input, 'createdAt', task.createdAt);
  setIfDefined(input, 'startedAt', task.startedAt);
  setIfDefined(input, 'stoppedAt', task.stoppedAt);
  setIfDefined(input, 'cpus', task.cpus);
  setIfDefined(input, 'memory', task.memory);
  setIfDefined(input, 'instanceType', task.instanceType);
  setIfDefined(input, 'statusMessage', task.statusMessage);
  setIfDefined(input, 'failureReason', task.failureReason);
  return input;
}

/** True when `value` is a non-empty (non-whitespace) identifier string (Req 4.9). */
function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * AppSync GraphQL publisher using SigV4 IAM authorization (Req 4.1–4.3, 4.8, 4.9).
 */
export class AppSyncPublisher {
  private readonly endpoint: string;
  private readonly region: string;
  private readonly credentials: AwsCredentialIdentityProvider;
  private readonly transport: HttpTransport;
  private readonly maxAttempts: number;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(options: AppSyncPublisherOptions = {}) {
    const endpoint = options.endpoint ?? process.env.APPSYNC_ENDPOINT;
    const region = options.region ?? process.env.AWS_REGION;
    if (!isValidIdentifier(endpoint)) {
      throw new Error(
        'AppSyncPublisher requires an endpoint (set APPSYNC_ENDPOINT or pass options.endpoint)',
      );
    }
    if (!isValidIdentifier(region)) {
      throw new Error(
        'AppSyncPublisher requires a region (set AWS_REGION or pass options.region)',
      );
    }
    this.endpoint = endpoint;
    this.region = region;
    this.credentials = options.credentials ?? defaultProvider();
    this.transport = options.transport ?? defaultTransport;
    this.maxAttempts = options.maxAttempts ?? MAX_PUBLISH_ATTEMPTS;
    this.log = options.logger ?? ((message, error) => console.error(message, error));
  }

  /**
   * Publish a persisted run change via the `publishRunUpdate` mutation (Req 4.1).
   * Rejects before any call when `runId` is missing/empty (Req 4.9); retries up
   * to the attempt budget and records a failure without throwing when all fail
   * (Req 4.8).
   */
  async publishRunUpdate(run: RunRecord): Promise<PublishResult> {
    if (!isValidIdentifier(run.runId)) {
      const error = new InvalidPublishIdentifierError('publishRunUpdate', 'runId');
      this.log(error.message);
      return { outcome: 'rejected', error };
    }
    return this.dispatch('publishRunUpdate', RUN_MUTATION, toRunInput(run), run.runId);
  }

  /**
   * Publish a persisted task change via the `publishTaskUpdate` mutation (Req 4.2).
   * Rejects before any call when `runId` or `taskId` is missing/empty (Req 4.9);
   * retries up to the attempt budget and records a failure without throwing when
   * all fail (Req 4.8).
   */
  async publishTaskUpdate(task: TaskRecord): Promise<PublishResult> {
    if (!isValidIdentifier(task.runId)) {
      const error = new InvalidPublishIdentifierError('publishTaskUpdate', 'runId');
      this.log(error.message);
      return { outcome: 'rejected', error };
    }
    if (!isValidIdentifier(task.taskId)) {
      const error = new InvalidPublishIdentifierError('publishTaskUpdate', 'taskId');
      this.log(error.message);
      return { outcome: 'rejected', error };
    }
    return this.dispatch(
      'publishTaskUpdate',
      TASK_MUTATION,
      toTaskInput(task),
      `${task.runId}/${task.taskId}`,
    );
  }

  /**
   * Sign and POST the mutation, retrying on failure up to the attempt budget.
   * Returns a `failed` result (never throws) when every attempt fails so the
   * caller retains and logs the already-persisted data unchanged (Req 4.8).
   */
  private async dispatch(
    mutation: 'publishRunUpdate' | 'publishTaskUpdate',
    query: string,
    input: RunInput | TaskInput,
    identifier: string,
  ): Promise<PublishResult> {
    const body = JSON.stringify({ query, variables: { input } });

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.send(body);
        return { outcome: 'published' };
      } catch (err) {
        lastError = err;
        this.log(
          `publish: ${mutation}(${identifier}) attempt ${attempt}/${this.maxAttempts} failed`,
          err,
        );
      }
    }

    // Every attempt failed: record the publish failure while the persisted data
    // is retained unchanged (Req 4.8). Do NOT throw — return a failed result.
    const error = new PublishFailedError(mutation, identifier, lastError);
    this.log(error.message, lastError);
    return { outcome: 'failed', error };
  }

  /**
   * SigV4-sign the GraphQL POST with IAM credentials and send it via the
   * transport (Req 4.3). Throws on a non-2xx status or a GraphQL `errors` array
   * so {@link dispatch} treats it as a retryable failure.
   */
  private async send(body: string): Promise<void> {
    const url = new URL(this.endpoint);
    const signer = new SignatureV4({
      service: APPSYNC_SERVICE,
      region: this.region,
      credentials: this.credentials,
      sha256: Sha256,
    });

    const signed = await signer.sign({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      headers: {
        'content-type': 'application/json',
        host: url.host,
      },
      body,
    });

    const response = await this.transport(this.endpoint, {
      method: 'POST',
      headers: signed.headers,
      body,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`AppSync responded with HTTP ${response.status}`);
    }

    // AppSync returns 200 with an `errors` array for GraphQL-level failures;
    // treat those as failures so they are retried (Req 4.8).
    const text = await response.text();
    if (text) {
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        // A non-JSON 2xx body is unexpected but not fatal; accept it.
        return;
      }
      const errors = (payload as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        throw new Error(`AppSync GraphQL errors: ${JSON.stringify(errors)}`);
      }
    }
  }
}
