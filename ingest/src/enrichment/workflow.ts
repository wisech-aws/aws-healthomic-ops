/**
 * Workflow-definition enrichment via the HealthOmics `GetWorkflow` read API.
 *
 * On first sighting of a run's `workflowId` with no cached static graph, the
 * ingest Lambda fetches the workflow definition through `GetWorkflow` — one of
 * the four allowed read operations (Req 2.1) — and resolves it into a
 * {@link WorkflowDefinition} the parser module can consume. `GetWorkflow`
 * returns the definition as a short-lived **presigned S3 URL** to a
 * `definition.zip`; this module downloads that bundle and unzips it into a
 * File_Map entirely within the same invocation (Req 1.1–1.5). Graph parsing and
 * caching happen elsewhere; this module's sole job is to fetch, download, and
 * unzip the definition and normalize its File_Map + Main_Path + language.
 *
 * The `GetWorkflow` call is wrapped by {@link callWithRetry} so it has a
 * per-call timeout and up to 3 attempts; on persistent failure (or a missing
 * URL, a failed download, or a corrupt bundle) the operation, reason, and
 * `workflowId` are logged and the function returns `null` so the caller can
 * abort static-graph creation while preserving prior state (Req 1.6, 1.7, 1.8,
 * 1.9). This function never throws for a fetch/download/unzip failure.
 *
 * ============================================================================
 * CONFIRM AGAINST AWS DOCS — GetWorkflow definition URL + main + language
 * ----------------------------------------------------------------------------
 * This file is a designated "confirm against AWS docs" location (design.md
 * table; Req 1.1, 1.5): the assumptions about WHERE `GetWorkflow` returns the
 * definition bundle URL, the entry-file name, and the declared language are
 * isolated behind the clearly-marked constants and `resolveDefinitionUrl()` /
 * `resolveMainPath()` / `resolveLanguage()` helpers below.
 *
 * Current assumptions, taken from the `@aws-sdk/client-omics` `GetWorkflow`
 * model, that MUST be confirmed against the AWS HealthOmics API reference:
 *
 *   1. Definition URL. We assume the `definition` field of the `GetWorkflow`
 *      response — when the workflow is requested with `export: [DEFINITION]` —
 *      carries a **presigned S3 URL** pointing at a `definition.zip` bundle
 *      (NOT inline definition text). The URL is short-lived (~600s TTL) so it
 *      must be downloaded within the same invocation and never persisted. See
 *      `DEFINITION_URL_FIELD` and `WORKFLOW_EXPORT_DEFINITION`.
 *
 *   2. Main path. We assume the entry-file name within the bundle is carried by
 *      the `main` field (e.g. `main.nf`), and it keys the entry file in the
 *      unzipped File_Map. See `WORKFLOW_MAIN_FIELD` and `resolveMainPath()`.
 *
 *   3. Language. We assume the workflow's language is carried by the `engine`
 *      field (values `WDL` / `WDL_LENIENT` / `NEXTFLOW` / `CWL`) and map it to
 *      our `Language` union, folding `WDL_LENIENT` into `WDL`. See
 *      `WORKFLOW_LANGUAGE_FIELD` and `mapEngineToLanguage()`.
 *
 * If any assumption is wrong, update ONLY the constants and resolver helpers in
 * this file.
 * ============================================================================
 */

import {
  GetWorkflowCommand,
  WorkflowExport,
  type OmicsClient,
  type GetWorkflowCommandOutput,
} from '@aws-sdk/client-omics';

import type { Language, WorkflowDefinition } from '../parser/types.js';
import { callWithRetry, type RetryOptions } from './retry.js';
import { unzipToFileMap } from './unzip.js';

// CONFIRM AGAINST AWS DOCS: the export mode requested so `GetWorkflow` returns
// the definition bundle URL rather than only metadata.
const WORKFLOW_EXPORT_DEFINITION = WorkflowExport.DEFINITION;

// CONFIRM AGAINST AWS DOCS: the response field carrying the presigned S3 URL to
// the `definition.zip` bundle. If HealthOmics returns the definition in some
// other shape (e.g. inline text or a structured location), resolving the URL
// must be extended (see `resolveDefinitionUrl`).
const DEFINITION_URL_FIELD = 'definition' as const;

// CONFIRM AGAINST AWS DOCS: the response field naming the entry (main) file
// within the definition bundle. Used to derive the File_Map's `mainPath`.
const WORKFLOW_MAIN_FIELD = 'main' as const;

// CONFIRM AGAINST AWS DOCS: the response field carrying the workflow language.
const WORKFLOW_LANGUAGE_FIELD = 'engine' as const;

// Fallback entry-file path used when the response carries no explicit main
// file name, so the produced File_Map still has a well-defined entry key.
const DEFAULT_MAIN_PATH = 'main' as const;

/**
 * Map a HealthOmics `WorkflowEngine` value to our parser {@link Language}.
 *
 * CONFIRM AGAINST AWS DOCS: the engine spellings. `WDL_LENIENT` is folded into
 * `WDL` because it is a WDL dialect the WDL parser handles. An unrecognized
 * engine is returned verbatim so the parser dispatcher rejects it as an
 * unsupported language (Req 2.7) rather than silently guessing.
 */
function mapEngineToLanguage(engine: string | undefined): Language | string {
  switch (engine) {
    case 'WDL':
    case 'WDL_LENIENT':
      return 'WDL';
    case 'NEXTFLOW':
      return 'NEXTFLOW';
    case 'CWL':
      return 'CWL';
    default:
      // Preserve the raw value (or empty string) so the caller/parser can
      // report an "unsupported language" reason identifying what was seen.
      return engine ?? '';
  }
}

/**
 * Resolve the presigned definition-bundle URL from a `GetWorkflow` response.
 *
 * CONFIRM AGAINST AWS DOCS: reads the `definition` field, which carries a
 * presigned S3 URL to the `definition.zip` bundle. Returns the URL string, or
 * `undefined` when the response carries no usable URL, in which case the caller
 * treats the fetch as unsuccessful and aborts graph creation (Req 1.7).
 */
function resolveDefinitionUrl(res: GetWorkflowCommandOutput): string | undefined {
  const url = res[DEFINITION_URL_FIELD];
  if (typeof url === 'string' && url.length > 0) {
    return url;
  }
  return undefined;
}

/**
 * Resolve the entry (main) file path for the definition's File_Map.
 *
 * CONFIRM AGAINST AWS DOCS: reads the `main` field (e.g. `main.nf`) when
 * present, otherwise falls back to {@link DEFAULT_MAIN_PATH}. This names the
 * entry file within the unzipped File_Map (Req 1.5, 2.2).
 */
function resolveMainPath(res: GetWorkflowCommandOutput): string {
  const main = (res as unknown as Record<string, unknown>)[WORKFLOW_MAIN_FIELD];
  if (typeof main === 'string' && main.length > 0) {
    return main;
  }
  return DEFAULT_MAIN_PATH;
}

/**
 * Resolve the declared language from a `GetWorkflow` response.
 * CONFIRM AGAINST AWS DOCS: reads the `engine` field (see resolver above).
 */
function resolveLanguage(res: GetWorkflowCommandOutput): Language | string {
  return mapEngineToLanguage(res[WORKFLOW_LANGUAGE_FIELD]);
}

/**
 * Default downloader for the definition bundle bytes, using the Node 20 global
 * `fetch`. GETs the presigned URL, rejects a non-2xx response with a clear
 * message, and returns the response body as a {@link Uint8Array}.
 *
 * @param url The presigned S3 URL to the `definition.zip` bundle.
 * @returns The raw bundle bytes.
 * @throws {Error} On a non-2xx response or any network/read failure.
 */
async function defaultDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `download of definition bundle failed with HTTP ${response.status} ${response.statusText}`,
    );
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Options controlling {@link getWorkflowDefinition}. Extends the retry/timeout
 * {@link RetryOptions} with an injectable `download` seam so tests can supply
 * bundle bytes without hitting the network.
 */
export interface DefinitionFetchOptions extends RetryOptions {
  /**
   * Injectable fetcher for the definition-bundle bytes; defaults to a global
   * `fetch`-based downloader ({@link defaultDownload}). Injected in tests to
   * return zipped bytes without a network call.
   */
  download?: (url: string) => Promise<Uint8Array>;
}

/**
 * Fetch, download, and unzip a workflow definition via `GetWorkflow`
 * (Req 1.1–1.5, 2.3).
 *
 * Calls `GetWorkflow` with `export=[DEFINITION]` (wrapped by
 * {@link callWithRetry}), reads the presigned bundle URL from the `definition`
 * field, downloads the bundle within the same invocation (never persisting the
 * URL), unzips it in memory into a File_Map, and returns a normalized
 * {@link WorkflowDefinition} — `workflowId`, resolved `language`, `files`, and
 * `mainPath` — ready for the parser module.
 *
 * Returns `null` when the call fails after retries (Req 1.6), the response
 * carries no usable URL, the download fails (Req 1.7), or the bundle cannot be
 * unzipped (Req 1.8). On every failure the operation/reason and `workflowId`
 * are logged and the caller aborts static-graph creation, preserving prior
 * state (Req 1.9). This function never throws for a fetch/download/unzip error.
 *
 * @param client     The HealthOmics SDK client.
 * @param workflowId The workflow to fetch; echoed into failure logs.
 * @param options    Retry/timeout overrides plus an optional `download` seam.
 */
export async function getWorkflowDefinition(
  client: OmicsClient,
  workflowId: string,
  options?: DefinitionFetchOptions,
): Promise<WorkflowDefinition | null> {
  const download = options?.download ?? defaultDownload;

  // 1. GetWorkflow (export=[DEFINITION]), retried/timed-out by callWithRetry.
  //    On persistent failure callWithRetry has already logged; return null.
  const result = await callWithRetry(
    'GetWorkflow',
    workflowId,
    () =>
      client.send(
        new GetWorkflowCommand({
          id: workflowId,
          export: [WORKFLOW_EXPORT_DEFINITION],
        }),
      ),
    options,
  );
  if (!result.ok) {
    return null;
  }

  // 2. Resolve the presigned bundle URL. A missing URL is treated like a fetch
  //    failure: log and abort graph creation (Req 1.7).
  const url = resolveDefinitionUrl(result.value);
  if (url === undefined) {
    console.warn(
      `enrichment: GetWorkflow(${workflowId}) returned no definition bundle URL; ` +
        `cannot build static graph`,
    );
    return null;
  }

  // 3. Download the bundle bytes WITHIN this invocation (Req 1.2). The presigned
  //    URL is used immediately and never stored (Req 1.3). On failure, log the
  //    reason + workflowId and return null (Req 1.7).
  let bytes: Uint8Array;
  try {
    bytes = await download(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `enrichment: GetWorkflow(${workflowId}) definition bundle download failed: ${reason}`,
    );
    return null;
  }

  // 4. Unzip the bundle into an in-memory File_Map (Req 1.4). A corrupt/oversized
  //    bundle throws; treat it as an unzip failure: log reason + workflowId and
  //    return null (Req 1.8).
  let files: Record<string, string>;
  try {
    files = unzipToFileMap(bytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `enrichment: GetWorkflow(${workflowId}) definition bundle unzip failed: ${reason}`,
    );
    return null;
  }

  // 5. Resolve the entry path and language (Req 1.5).
  const mainPath = resolveMainPath(result.value);
  const language = resolveLanguage(result.value);

  // 6. Return the normalized definition for the parser module (Req 2.3).
  return { workflowId, language, files, mainPath };
}
