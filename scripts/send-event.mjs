#!/usr/bin/env node
/**
 * send-event.mjs — synthetic-event / direct-invoke operator script
 * (Requirements 13.4, 13.6).
 *
 * Selectable by the operator, this script EITHER:
 *   (a) publishes a synthetic `aws.omics` event to Amazon EventBridge
 *       (PutEvents via @aws-sdk/client-eventbridge), OR
 *   (b) invokes the ingest Lambda directly with a fixture
 *       (Invoke via @aws-sdk/client-lambda).
 *
 * Before it sends anything, it validates the fixture against the same schema
 * the ingest pipeline assumes (see ingest/src/eventMapper.ts): the event
 * `source` must be `aws.omics`, the `detail-type` must be one of the two known
 * HealthOmics status-change types, and the required `detail` fields for that
 * type must be present. An event that fails validation is REJECTED with a clear
 * error and NOTHING is sent, so existing run/task data is left unchanged
 * (Req 13.6).
 *
 * The validation and arg-parsing paths are fully exercisable WITHOUT AWS
 * credentials or the AWS SDK installed: `--help` and `--dry-run` never import
 * the SDK and never touch the network. The AWS SDK clients are imported lazily
 * only when an event is actually being sent.
 *
 * Usage:
 *   scripts/send-event.mjs --mode <eventbridge|lambda> [options]
 *
 * Modes:
 *   eventbridge   Publish the fixture as a synthetic event via PutEvents.
 *   lambda        Invoke the ingest Lambda directly with the fixture payload.
 *
 * Options:
 *   --mode <m>          Required (unless --dry-run). One of: eventbridge, lambda.
 *   --fixture <path>    Path to the event fixture JSON. Defaults to the bundled
 *                       run fixture. Shorthands: `run` and `task` select the
 *                       bundled fixtures/events/{run,task}-status-change.json.
 *   --function <name>   Lambda function name/ARN (lambda mode). Also read from
 *                       $INGEST_FUNCTION_NAME.
 *   --event-bus <name>  EventBridge bus name (eventbridge mode). Defaults to
 *                       "default". Also read from $EVENT_BUS_NAME.
 *   --region <region>   AWS region. Also read from $AWS_REGION.
 *   --dry-run           Validate the fixture and print what WOULD be sent, then
 *                       exit. Never imports the SDK; never contacts AWS.
 *   --help, -h          Print this help and exit.
 *
 * Examples:
 *   # Validate the bundled run fixture without touching AWS:
 *   scripts/send-event.mjs --dry-run --fixture run
 *
 *   # Publish a synthetic task event to the default bus:
 *   scripts/send-event.mjs --mode eventbridge --fixture task --region us-west-2
 *
 *   # Invoke the ingest Lambda directly with a run fixture:
 *   scripts/send-event.mjs --mode lambda --fixture run \
 *       --function healthomics-ingest --region us-west-2
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures', 'events');

// ---------------------------------------------------------------------------
// Schema constants — kept in lockstep with ingest/src/eventMapper.ts and
// ingest/src/domain/status.ts. These are the SAME assumptions the ingest
// pipeline makes, so validation here mirrors what the Lambda would accept.
// ---------------------------------------------------------------------------
const EXPECTED_SOURCE = 'aws.omics';
const RUN_DETAIL_TYPE = 'Run Status Change';
const TASK_DETAIL_TYPE = 'Task Status Change';

// Required `detail` fields per event type. The task id is carried only by the
// task `arn` (segment after "task/"), so `arn` is required for task events.
const REQUIRED_RUN_DETAIL_FIELDS = [
  'runId',
  'status',
  'runName',
  'workflowId',
  'workflowName',
];
const REQUIRED_TASK_DETAIL_FIELDS = ['runId', 'status', 'name', 'arn'];
const TASK_ARN_RESOURCE_PREFIX = 'task/';

const RUN_STATUSES = new Set([
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'DELETED',
  'CANCELLED',
  'FAILED',
]);
const TASK_STATUSES = new Set([
  'PENDING',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);

/** Thrown when a fixture fails schema validation. Carries a clear message. */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const HELP_TEXT = `send-event.mjs — publish a synthetic aws.omics event or invoke the ingest Lambda

Usage:
  send-event.mjs --mode <eventbridge|lambda> [options]
  send-event.mjs --dry-run [--fixture <run|task|path>]

Options:
  --mode <m>          eventbridge | lambda (required unless --dry-run)
  --fixture <path>    fixture JSON path, or the shorthand 'run' / 'task'
                      (default: run)
  --function <name>   Lambda function name/ARN (lambda mode; or $INGEST_FUNCTION_NAME)
  --event-bus <name>  EventBridge bus name (eventbridge mode; default 'default'
                      or $EVENT_BUS_NAME)
  --region <region>   AWS region (or $AWS_REGION)
  --dry-run           validate + print what would be sent; never contacts AWS
  --help, -h          show this help

Examples:
  send-event.mjs --dry-run --fixture run
  send-event.mjs --mode eventbridge --fixture task --region us-west-2
  send-event.mjs --mode lambda --fixture run --function healthomics-ingest
`;

/**
 * Parse argv into an options object. Unknown flags are an error so operator
 * typos never silently fall through to a no-op send.
 */
function parseArgs(argv) {
  const opts = {
    mode: undefined,
    fixture: 'run',
    function: process.env.INGEST_FUNCTION_NAME,
    eventBus: process.env.EVENT_BUS_NAME ?? 'default',
    region: process.env.AWS_REGION,
    dryRun: false,
    help: false,
  };

  const takesValue = new Set([
    '--mode',
    '--fixture',
    '--function',
    '--event-bus',
    '--region',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ValidationError(`Missing value for ${arg}`);
      }
      i += 1;
      switch (arg) {
        case '--mode':
          opts.mode = value;
          break;
        case '--fixture':
          opts.fixture = value;
          break;
        case '--function':
          opts.function = value;
          break;
        case '--event-bus':
          opts.eventBus = value;
          break;
        case '--region':
          opts.region = value;
          break;
      }
      continue;
    }
    throw new ValidationError(`Unknown argument: ${arg}`);
  }

  return opts;
}

/** Resolve a fixture reference ('run' | 'task' | path) to an absolute path. */
function resolveFixturePath(ref) {
  if (ref === 'run') {
    return path.join(FIXTURES_DIR, 'run-status-change.json');
  }
  if (ref === 'task') {
    return path.join(FIXTURES_DIR, 'task-status-change.json');
  }
  return path.resolve(process.cwd(), ref);
}

/** Read and JSON-parse a fixture file, surfacing clear errors. */
async function loadFixture(fixturePath) {
  let raw;
  try {
    raw = await readFile(fixturePath, 'utf8');
  } catch (err) {
    throw new ValidationError(
      `Cannot read fixture at ${fixturePath}: ${err.message}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(
      `Fixture at ${fixturePath} is not valid JSON: ${err.message}`,
    );
  }
}

/**
 * Validate an event object against the ingest schema. Throws ValidationError
 * with a clear, single message identifying the failure (Req 13.6). Returns the
 * detected kind ('RUN' | 'TASK') on success.
 */
export function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new ValidationError('Event must be a JSON object.');
  }

  if (event.source !== EXPECTED_SOURCE) {
    throw new ValidationError(
      `Invalid event source: expected "${EXPECTED_SOURCE}", got ${JSON.stringify(
        event.source,
      )}.`,
    );
  }

  const detailType = event['detail-type'];
  if (detailType !== RUN_DETAIL_TYPE && detailType !== TASK_DETAIL_TYPE) {
    throw new ValidationError(
      `Invalid detail-type: expected "${RUN_DETAIL_TYPE}" or "${TASK_DETAIL_TYPE}", got ${JSON.stringify(
        detailType,
      )}.`,
    );
  }

  const detail = event.detail;
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new ValidationError('Event "detail" must be a JSON object.');
  }

  const isRun = detailType === RUN_DETAIL_TYPE;
  const required = isRun
    ? REQUIRED_RUN_DETAIL_FIELDS
    : REQUIRED_TASK_DETAIL_FIELDS;

  const missing = required.filter((field) => {
    const value = detail[field];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required detail field(s) for "${detailType}": ${missing.join(
        ', ',
      )}.`,
    );
  }

  // Status must be a member of the appropriate enum.
  const statuses = isRun ? RUN_STATUSES : TASK_STATUSES;
  if (!statuses.has(detail.status)) {
    throw new ValidationError(
      `Invalid status "${detail.status}" for "${detailType}"; expected one of: ${[
        ...statuses,
      ].join(', ')}.`,
    );
  }

  // For task events the id lives only in the arn; ensure it is parseable.
  if (!isRun) {
    const arn = detail.arn;
    const idx = arn.indexOf(TASK_ARN_RESOURCE_PREFIX);
    const taskId =
      idx === -1
        ? ''
        : arn.slice(idx + TASK_ARN_RESOURCE_PREFIX.length).trim();
    if (taskId.length === 0) {
      throw new ValidationError(
        `Task event "arn" does not contain a task id (expected "...${TASK_ARN_RESOURCE_PREFIX}<id>"): ${JSON.stringify(
          arn,
        )}.`,
      );
    }
  }

  return isRun ? 'RUN' : 'TASK';
}

/** Publish the event to EventBridge via PutEvents (lazy SDK import). */
async function publishToEventBridge(event, opts) {
  const { EventBridgeClient, PutEventsCommand } = await import(
    '@aws-sdk/client-eventbridge'
  );
  const client = new EventBridgeClient(
    opts.region ? { region: opts.region } : {},
  );
  const response = await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: opts.eventBus,
          Source: event.source,
          DetailType: event['detail-type'],
          Detail: JSON.stringify(event.detail),
          Resources: Array.isArray(event.resources) ? event.resources : [],
          Time: event.time ? new Date(event.time) : undefined,
        },
      ],
    }),
  );
  if (response.FailedEntryCount && response.FailedEntryCount > 0) {
    const entry = response.Entries?.[0];
    throw new Error(
      `EventBridge PutEvents reported a failed entry: ${entry?.ErrorCode ?? 'Unknown'} ${entry?.ErrorMessage ?? ''}`.trim(),
    );
  }
  return response.Entries?.[0]?.EventId;
}

/** Invoke the ingest Lambda directly with the event payload (lazy SDK import). */
async function invokeLambda(event, opts) {
  if (!opts.function) {
    throw new ValidationError(
      'lambda mode requires --function <name> (or $INGEST_FUNCTION_NAME).',
    );
  }
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const client = new LambdaClient(opts.region ? { region: opts.region } : {});
  const response = await client.send(
    new InvokeCommand({
      FunctionName: opts.function,
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
  const payload = response.Payload
    ? Buffer.from(response.Payload).toString('utf8')
    : '';
  if (response.FunctionError) {
    throw new Error(
      `Lambda returned FunctionError=${response.FunctionError}: ${payload}`,
    );
  }
  return { statusCode: response.StatusCode, payload };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const fixturePath = resolveFixturePath(opts.fixture);
  const event = await loadFixture(fixturePath);

  // Validate first, always. Invalid events are rejected before anything is
  // sent, so existing data is left unchanged (Req 13.6).
  const kind = validateEvent(event);

  if (opts.dryRun) {
    process.stdout.write(
      `[dry-run] Fixture is valid.\n` +
        `  fixture:     ${fixturePath}\n` +
        `  kind:        ${kind}\n` +
        `  source:      ${event.source}\n` +
        `  detail-type: ${event['detail-type']}\n` +
        `  status:      ${event.detail.status}\n` +
        `  mode:        ${opts.mode ?? '(none — nothing would be sent)'}\n` +
        `No AWS calls were made.\n`,
    );
    return;
  }

  if (opts.mode === 'eventbridge') {
    const eventId = await publishToEventBridge(event, opts);
    process.stdout.write(
      `Published ${kind} event to EventBridge bus "${opts.eventBus}". EventId=${eventId ?? '(none)'}\n`,
    );
    return;
  }

  if (opts.mode === 'lambda') {
    const result = await invokeLambda(event, opts);
    process.stdout.write(
      `Invoked ingest Lambda "${opts.function}" with ${kind} event. StatusCode=${result.statusCode}\n` +
        (result.payload ? `Response payload: ${result.payload}\n` : ''),
    );
    return;
  }

  throw new ValidationError(
    'Missing or invalid --mode. Use "eventbridge" or "lambda", or pass --dry-run. See --help.',
  );
}

// Only run when executed directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    if (err instanceof ValidationError) {
      process.stderr.write(`Validation error: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    }
  });
}
