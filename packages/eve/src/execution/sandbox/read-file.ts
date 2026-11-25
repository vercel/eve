import { normalizeModelPath } from "#execution/tools/file-state.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import {
  detectImageMediaType,
  hasPdfHeader,
  type MediaMetadata,
} from "#internal/attachments/media-metadata.js";
import { readMediaMetadata } from "#internal/attachments/read-media-metadata.js";
import { inlinesSandboxRefAsBytes } from "#internal/attachments/sandbox-refs.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { capLineLength, MAX_OUTPUT_BYTES } from "#execution/sandbox/truncate-output.js";

const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 2000;

export interface ReadFileInput {
  readonly filePath: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReadFileResult {
  readonly content: string;
  readonly file?: MediaMetadata;
  readonly nextOffset?: number;
  readonly path: string;
  readonly totalLines: number;
  readonly truncated: boolean;
}

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
      `File not found: ${normalizedPath}. Verify the path exists and is accessible in the sandbox.`,
    );
  }

  if (hasPdfHeader(bytes)) {
    return buildFileReadResult(bytes, normalizedPath, "application/pdf");
  }
  const rawContent = decodeUtf8(bytes);
  if (rawContent === undefined || rawContent.includes("\0")) {
    const imageMediaType = detectImageMediaType(bytes);
    if (imageMediaType !== undefined) {
      return buildFileReadResult(bytes, normalizedPath, imageMediaType);
    }
    throw new Error(
      `File "${normalizedPath}" appears to be a binary file. ` +
        "read_file only supports text files, PNG, JPEG, GIF, or WebP images, and PDFs.",
    );
  }

  const effectiveOffset = offset ?? DEFAULT_OFFSET;
  const effectiveLimit = limit ?? DEFAULT_LIMIT;

  if (effectiveOffset < 1) {
    throw new Error(`offset must be >= 1. Received: ${effectiveOffset}.`);
  }

  const allLines = rawContent.split("\n");
  const totalLines =
    allLines.length > 0 && allLines[allLines.length - 1] === ""
      ? allLines.length - 1
      : allLines.length;

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

  if (totalLines === 0) {
    return {
      content: "",
      path: normalizedPath,
      totalLines: 0,
      truncated: false,
    };
  }

  const startIndex = effectiveOffset - 1;
  const endIndex = Math.min(startIndex + effectiveLimit, totalLines);
  const selectedLines = allLines.slice(startIndex, endIndex);

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedByBytes = false;

  for (let i = 0; i < selectedLines.length; i++) {
    const lineNumber = effectiveOffset + i;
    const line = capLineLength(selectedLines[i] ?? "");
    const numbered = `${lineNumber}: ${line}`;
    const lineBytes = Buffer.byteLength(numbered, "utf8") + 1;

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

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function buildFileReadResult(bytes: Uint8Array, path: string, mediaType: string): ReadFileResult {
  const file = readMediaMetadata(bytes, mediaType);
  const pdf = mediaType === "application/pdf";
  if (!inlinesSandboxRefAsBytes({ ...file, path })) {
    throw new Error(
      pdf
        ? `PDF "${path}" is ${bytes.byteLength} bytes; read_file shows PDFs up to 20 MiB. ` +
            "Split it or extract its text in the sandbox first."
        : `Image "${path}" is ${describeImage(file)}; read_file shows images up to 3 MiB and ` +
            "8000 pixels per side. Resize or crop it in the sandbox first.",
    );
  }
  const pages =
    file.pages === undefined ? "" : `, ${file.pages} ${file.pages === 1 ? "page" : "pages"}`;
  return {
    content: `${pdf ? "PDF" : "Image"} ${path} (${mediaType}, ${bytes.byteLength} bytes${pages}).`,
    file,
    path,
    totalLines: 0,
    truncated: false,
  };
}

function describeImage(file: MediaMetadata): string {
  const size = `${file.size} bytes`;
  return file.width === undefined ? size : `${file.width}x${file.height} pixels, ${size}`;
}
