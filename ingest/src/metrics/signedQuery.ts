/**
 * Signed-request builder for HealthOmics utilization metrics.
 *
 * There is **no AWS SDK operation** for CloudWatch's Prometheus-compatible PromQL query
 * API, so `metricsHandler.ts` must construct and SigV4-sign a raw HTTPS POST itself. This
 * module isolates that: it form-encodes the `query_range` request body and signs/issues the
 * POST, so all other modules deal only in typed params and a parsed
 * {@link PrometheusEnvelope} (or a typed HTTP-error signal) — never in signing/HTTP details.
 *
 * VERIFIED grounding facts (treated as constraints, not assumptions):
 *   - The SigV4 signing service name is `monitoring` (not `execute-api`/`aps` etc).
 *   - `query_range` requires RFC3339 `start`/`end` and a **numeric-seconds** `step` string
 *     (e.g. `"30"`, not `"30s"`).
 *   - The endpoint is `https://monitoring.<region>.amazonaws.com/api/v1/query_range`.
 *   - The request is a POST with `Content-Type: application/x-www-form-urlencoded`.
 *
 * @smithy/protocol-http's `HttpRequest` class is **not** a resolvable dependency of this
 * package (checked: `require.resolve('@smithy/protocol-http')` fails even though
 * `@smithy/signature-v4` is installed). Rather than add a new direct dependency for a class
 * that only wraps a plain object, this module builds a plain object matching the
 * `HttpRequest` interface shape from `@smithy/types` (a real transitive dependency of
 * `@smithy/signature-v4`), which is exactly what `SignatureV4.sign()` expects structurally.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { HttpRequest } from '@smithy/types';
import type { PrometheusEnvelope } from './parse.js';

/** The minimum PromQL query resolution, in seconds (Req 8.2). */
const MIN_STEP_SECONDS = 30;

/** Parameters for a single `query_range` request. */
export interface RangeParams {
  /** The PromQL selector expression, e.g. from {@link buildSelector} in `promql.ts`. */
  query: string;
  /** RFC3339 range start. */
  start: string;
  /** RFC3339 range end. */
  end: string;
  /** Numeric-seconds resolution string, e.g. `"30"` (never `"30s"`). */
  step: string;
}

/**
 * Form-encode a `query_range` request body.
 *
 * Encodes `query`, `start` (RFC3339), `end` (RFC3339), and `step` (numeric-seconds string)
 * via `URLSearchParams` — matching `Content-Type: application/x-www-form-urlencoded` (Req
 * 1.4). This function clamps/validates nothing itself: callers (task 2.5's bounding logic,
 * {@link clampStepSeconds} below, or the handler) are responsible for ensuring `step`
 * represents a value `>= 30` before calling this.
 */
export function buildRangeBody(p: RangeParams): string {
  const body = new URLSearchParams();
  body.set('query', p.query);
  body.set('start', p.start);
  body.set('end', p.end);
  body.set('step', p.step);
  return body.toString();
}

/**
 * Clamp a requested step (seconds) to the minimum emission interval of 30s, defaulting to 30
 * when absent/invalid.
 *
 * HealthOmics emits utilization metrics at a 30-second interval, so requesting a finer
 * resolution would not surface any additional real data — the handler must never let a
 * caller-supplied `stepSeconds` below 30 (or a missing/non-finite one) through to
 * {@link buildRangeBody} (Req 8.2). Returns a numeric-seconds **string**, matching the
 * `step` field {@link buildRangeBody} expects.
 */
export function clampStepSeconds(requested: number | null | undefined): string {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < MIN_STEP_SECONDS) {
    return String(MIN_STEP_SECONDS);
  }
  return String(Math.floor(requested));
}

/** The result of {@link signAndPost}: either a parsed success envelope or a typed HTTP error. */
export type SignedPostResult =
  | { ok: true; envelope: PrometheusEnvelope }
  | { ok: false; httpErrorMessage: string };

/** How many characters of a non-2xx response body to include in the error message. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/**
 * SigV4-sign (service `monitoring`) and POST a `query_range` request, returning either the
 * parsed Prometheus envelope or a typed HTTP-error signal.
 *
 * Signing (Req 1.2): builds a `SignatureV4({ service, region, sha256: Sha256, credentials })`
 * signer — `service`/`region`/`credentials` are explicit parameters (not read from ambient
 * environment/module state) so tests can inject a fixed-credential signer and assert request
 * shape without a live call (Req 8.2's testability note; task 2.6). Signs a plain object
 * matching the `HttpRequest` shape (see module doc for why this isn't the
 * `@smithy/protocol-http` class): method `POST`, `host` header set to `host`,
 * `content-type: application/x-www-form-urlencoded`, and `body` as the form-encoded string.
 *
 * Transport: issues the actual HTTPS POST via Node 20's global `fetch`, to
 * `https://${host}${path}` (Req 1.2, 1.4), passing through the signed headers.
 *
 * Success vs error (Req 10.3, 10.4 — matches the design's Error Handling table): the JSON
 * response body is parsed into a {@link PrometheusEnvelope} **only** when the HTTP status is
 * 2xx. On a non-2xx status, this returns `{ ok: false, httpErrorMessage }` **without**
 * attempting to parse the body as Prometheus JSON — a non-2xx body is not trustworthy
 * Prometheus JSON and must not be handed to the parser.
 *
 * @param host The monitoring API host, e.g. `monitoring.us-east-1.amazonaws.com`.
 * @param region The signing region.
 * @param service The signing service name — always `"monitoring"` in production; kept as a
 *   parameter (rather than hardcoded) purely for injectability in tests.
 * @param path Always `/api/v1/query_range` in this module's current usage.
 * @param body The form-encoded request body, from {@link buildRangeBody}.
 */
export async function signAndPost(
  host: string,
  region: string,
  service: string,
  path: '/api/v1/query_range',
  body: string,
): Promise<SignedPostResult> {
  const signer = new SignatureV4({
    service,
    region,
    sha256: Sha256,
    credentials: defaultProvider(),
  });

  const requestToSign: HttpRequest = {
    method: 'POST',
    protocol: 'https:',
    hostname: host,
    path,
    headers: {
      host,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  };

  const signed = await signer.sign(requestToSign);

  const response = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: signed.headers,
    body,
  });

  if (!response.ok) {
    const excerpt = (await response.text().catch(() => '')).slice(0, ERROR_BODY_EXCERPT_LENGTH);
    return {
      ok: false,
      httpErrorMessage: `HTTP ${response.status} ${response.statusText}: ${excerpt}`,
    };
  }

  const envelope = (await response.json()) as PrometheusEnvelope;
  return { ok: true, envelope };
}
