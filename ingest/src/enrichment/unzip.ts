/**
 * In-memory decoder for a workflow **definition bundle** (`definition.zip`).
 *
 * The ingest Lambda downloads the definition bundle from a short-lived presigned
 * S3 URL and must decode it entirely within the same invocation (the URL is
 * never stored). This module turns the raw bundle bytes into an
 * archive-relative **File_Map** — `Record<archivePath, utf8Contents>` — that the
 * parser module consumes as the `files` field of a `WorkflowDefinition`
 * (design.md §2; Req 1.4).
 *
 * Decoding is fully synchronous and in-memory via `fflate`'s `unzipSync`, which
 * suits a bounded definition bundle and avoids async/Promise plumbing. `fflate`
 * is pure TypeScript with no native dependencies, so it bundles cleanly under
 * the ingest Lambda's esbuild config.
 *
 * A defensive uncompressed-size cap ({@link MAX_UNCOMPRESSED_BYTES}) protects the
 * Lambda from a pathological (e.g. zip-bomb) archive: if the total decoded bytes
 * exceed the cap, decoding throws rather than exhausting memory. A corrupt or
 * otherwise undecodable archive also throws. Both throws are caught upstream in
 * the definition fetcher and treated as an unzip failure (Req 1.8).
 */

import { unzipSync } from 'fflate';

/**
 * Defensive cap on the total uncompressed size of a definition bundle: 64 MiB.
 *
 * Definition bundles for real workflows are small (source files, not data), so
 * this cap is generous while still bounding the memory a single archive can
 * consume during decode. Exceeding it is treated as an unzip failure (Req 1.8).
 */
export const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

const utf8Decoder = new TextDecoder('utf-8');

/**
 * Decode a definition bundle into an archive-relative File_Map (Req 1.4).
 *
 * Decodes the whole archive in memory, skips directory entries, and returns only
 * regular files keyed by their archive-relative POSIX path exactly as stored
 * (e.g. `main.nf`, `workflows/rnaseq/main.nf`, `modules/nf-core/fastqc/main.nf`).
 * Each file's bytes are decoded as UTF-8 into a string.
 *
 * @param bytes The raw `definition.zip` bytes.
 * @returns A map from archive-relative path to UTF-8 file contents.
 * @throws {Error} If the archive is corrupt/undecodable, or if the total
 *   uncompressed size exceeds {@link MAX_UNCOMPRESSED_BYTES}.
 */
export function unzipToFileMap(bytes: Uint8Array): Record<string, string> {
  // Let fflate's own error propagate on a corrupt/undecodable archive; wrap it
  // with a clear message so upstream logs identify the failing step (Req 1.8).
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to unzip definition bundle: ${reason}`);
  }

  const files: Record<string, string> = {};
  let totalUncompressed = 0;

  for (const [path, content] of Object.entries(entries)) {
    // Skip directory entries; keep only regular files. `unzipSync` represents a
    // directory entry with a trailing slash in its name.
    if (path.endsWith('/')) {
      continue;
    }

    totalUncompressed += content.length;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(
        `definition bundle exceeds the uncompressed size cap of ` +
          `${MAX_UNCOMPRESSED_BYTES} bytes`,
      );
    }

    files[path] = utf8Decoder.decode(content);
  }

  return files;
}
