import { loadContext } from "#context/container.js";
import {
  buildReadFileTargetKey,
  createReadFileStamp,
  normalizeModelPath,
  setReadFileStamp,
} from "#execution/tools/file-state.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import { readMediaMetadata, type MediaMetadata } from "#internal/attachments/media-metadata.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { capLineLength, MAX_OUTPUT_BYTES } from "#execution/sandbox/truncate-output.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 2000;

// Matches the inline cap for inbound image attachments.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
// ---------------------------------------------------------------------------
// Input / result shapes
// ---------------------------------------------------------------------------

/**
 * Typed input accepted by {@link executeReadFileOnSandbox}.
 */
export interface ReadFileInput {
  readonly filePath: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Structured result returned from {@link executeReadFileOnSandbox}.
 */
export interface ReadFileResult {
  readonly content: string;
  /**
   * Set when the file is a PNG, JPEG, GIF, or WebP image the model sees as
   * an image. Carries no bytes, so `action.result` stays small.
   */
  readonly image?: MediaMetadata;
  readonly nextOffset?: number;
  readonly path: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Reads one text file from the sandbox, applies output shaping
 * (offset, limit, line numbering, truncation), and persists a full-file
 * stamp into durable read-file state for stale-write detection. Image
 * files return their bytes for the model to view instead.
 *
 * Used by the framework `read_file` tool and authored wrappers around its
 * exported definition.
 */
export async function executeReadFileOnSandbox(
  sandbox: SandboxSession,
  args: ReadFileInput,
): Promise<ReadFileResult> {
  const { filePath, offset, limit } = args;

  const resolvedPath = await resolveAbsoluteFilePath(sandbox, filePath);
  const normalizedPath = normalizeModelPath(resolvedPath);

  const bytes = await sandbox.readBinaryFile({ path: resolvedPath });
  if (bytes === null) {
    throw new Error(
      `File not found: ${filePath}. Verify the path exists and is accessible in the sandbox.`,
    );
  }
  const imageMediaType = detectImageMediaType(bytes);
  if (imageMediaType !== undefined) {
    return buildImageReadResult(bytes, normalizedPath, imageMediaType);
  }

  // ── Validate offset / limit ─────────────────────────────────────────
  const effectiveOffset = offset ?? DEFAULT_OFFSET;
  const effectiveLimit = limit ?? DEFAULT_LIMIT;

  if (effectiveOffset < 1) {
    throw new Error(`offset must be >= 1. Received: ${effectiveOffset}.`);
  }

  // ── Read full file for fingerprinting ───────────────────────────────
  const rawContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  // ── Reject non-text (NUL bytes) ─────────────────────────────────────
  if (rawContent.includes("\0")) {
    throw new Error(
      `File "${filePath}" contains NUL bytes and appears to be a binary file. ` +
        "read_file only supports text files.",
    );
  }

  // ── Split into lines ────────────────────────────────────────────────
  // Uses a simple newline split (not the ending-preserving variant in
  // session.ts) because the model-facing output re-joins with plain `\n`
  // and prepends line numbers — original endings are not preserved.
  const allLines = rawContent.split("\n");
  // Trailing newline produces an empty last element — preserve the line
  // count the way the user expects (a file ending with \n has N lines).
  const totalLines =
    allLines.length > 0 && allLines[allLines.length - 1] === ""
      ? allLines.length - 1
      : allLines.length;

  // ── Validate offset against file length ─────────────────────────────
  if (totalLines === 0) {
    if (effectiveOffset > 1) {
      throw new Error(
        `offset ${effectiveOffset} is past the end of the file (0 lines). ` +
          "Use the default offset to read an empty file.",
      );
    }
  } else if (effectiveOffset > totalLines) {
    throw new Error(`offset ${effectiveOffset} is past the end of the file (${totalLines} lines).`);
  }

  // ── Persist full-file stamp ─────────────────────────────────────────
  // Placed after all validation that can throw so a failed read_file call
  // (e.g. offset past end) never records a stamp, preserving the
  // read-before-write guarantee in write_file.
  const stamp = createReadFileStamp({
    content: rawContent,
    filePath: normalizedPath,
  });

  const targetKey = buildReadFileTargetKey(normalizedPath);
  setReadFileStamp(loadContext(), targetKey, stamp);

  // ── Handle empty file ───────────────────────────────────────────────
  if (totalLines === 0) {
    return {
      content: "",
      path: normalizedPath,
      totalLines: 0,
      truncated: false,
    };
  }

  // ── Apply offset and limit ──────────────────────────────────────────
  const startIndex = effectiveOffset - 1;
  const endIndex = Math.min(startIndex + effectiveLimit, totalLines);
  const selectedLines = allLines.slice(startIndex, endIndex);

  // ── Number and truncate lines, cap at MAX_OUTPUT_BYTES ──────────────
  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedByBytes = false;

  for (let i = 0; i < selectedLines.length; i++) {
    const lineNumber = effectiveOffset + i;
    const line = capLineLength(selectedLines[i] ?? "");
    const numbered = `${lineNumber}: ${line}`;
    const lineBytes = Buffer.byteLength(numbered, "utf8") + 1; // +1 for \n

    if (outputBytes + lineBytes > MAX_OUTPUT_BYTES && outputLines.length > 0) {
      truncatedByBytes = true;
      break;
    }

    outputLines.push(numbered);
    outputBytes += lineBytes;
  }

  const content = outputLines.join("\n");
  const linesReturned = outputLines.length;
  const lastLineReturned = effectiveOffset + linesReturned - 1;
  const isTruncated = lastLineReturned < totalLines || truncatedByBytes;

  if (isTruncated) {
    return {
      content,
      nextOffset: lastLineReturned + 1,
      path: normalizedPath,
      totalLines,
      truncated: true,
    };
  }

  return {
    content,
    path: normalizedPath,
    totalLines,
    truncated: false,
  };
}

function detectImageMediaType(bytes: Uint8Array): string | undefined {
  const startsWith = (signature: readonly number[]) =>
    signature.every((value, index) => bytes[index] === value);
  if (startsWith([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (startsWith([255, 216, 255])) return "image/jpeg";
  if (startsWith([71, 73, 70, 56, 55, 97]) || startsWith([71, 73, 70, 56, 57, 97])) {
    return "image/gif";
  }
  if (
    startsWith([82, 73, 70, 70]) &&
    [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)
  ) {
    return "image/webp";
  }
  return undefined;
}

function buildImageReadResult(bytes: Uint8Array, path: string, mediaType: string): ReadFileResult {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image "${path}" is ${bytes.byteLength} bytes; read_file shows images up to 3 MiB. ` +
        "Resize or crop it in the sandbox first.",
    );
  }
  return {
    content: `Image ${path} (${mediaType}, ${bytes.byteLength} bytes).`,
    image: readMediaMetadata(bytes, mediaType),
    path,
    totalLines: 0,
    truncated: false,
  };
}
