import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxReadTextFileOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import { bufferToStream, streamToBuffer } from "./stream-utils.js";

export type { InternalSandboxSession };

/**
 * Builds a public {@link SandboxSession} from backend-specific primitives.
 *
 * Encoding handling, line-range slicing, and the binary/text/stream
 * variants live here so each backend only has to implement byte-oriented
 * read/write primitives. `run` is implemented as a thin wrapper over the
 * backend's `spawn`: collect stdout/stderr to strings, await `wait()`,
 * then return the combined result.
 *
 * `setNetworkPolicy` applies a firewall policy to the live sandbox. It
 * defaults to a no-op so backends without a firewall (and test doubles)
 * need not supply one; the Vercel backend wires it to `sandbox.update`.
 */
export function buildSandboxSession(
  primitives: InternalSandboxSession,
  setNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void> = async () => {},
): SandboxSession {
  async function run(options: SandboxRunOptions) {
    const process = await primitives.spawn(options);
    const [stdout, stderr, { exitCode }] = await Promise.all([
      collectStreamToString(process.stdout),
      collectStreamToString(process.stderr),
      process.wait(),
    ]);
    return { exitCode, stderr, stdout };
  }
  return {
    id: primitives.id,
    resolvePath(path: string): string {
      return primitives.resolvePath(path);
    },
    run,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      return await primitives.spawn(options);
    },
    async readFile(options: SandboxReadFileOptions) {
      return await primitives.readFile({
        abortSignal: options.abortSignal,
        path: primitives.resolvePath(options.path),
      });
    },
    async readBinaryFile(options: SandboxReadBinaryFileOptions) {
      const stream = await primitives.readFile({
        abortSignal: options.abortSignal,
        path: primitives.resolvePath(options.path),
      });
      if (stream === null) {
        return null;
      }
      return await streamToBuffer(stream);
    },
    async readTextFile(options: SandboxReadTextFileOptions) {
      validateReadTextFileOptions(options);
      const stream = await primitives.readFile({
        abortSignal: options.abortSignal,
        path: primitives.resolvePath(options.path),
      });
      if (stream === null) {
        return null;
      }
      const buf = await streamToBuffer(stream);
      const text = decodeBytes(buf, options.encoding ?? "utf-8");
      return applyLineRange(text, options);
    },
    async writeFile(options: SandboxWriteFileOptions) {
      await primitives.writeFile({
        abortSignal: options.abortSignal,
        content: options.content,
        path: primitives.resolvePath(options.path),
      });
    },
    async writeBinaryFile(options: SandboxWriteBinaryFileOptions) {
      await primitives.writeFile({
        abortSignal: options.abortSignal,
        content: bufferToStream(options.content),
        path: primitives.resolvePath(options.path),
      });
    },
    async writeTextFile(options: SandboxWriteTextFileOptions) {
      const buf = encodeString(options.content, options.encoding ?? "utf-8");
      await primitives.writeFile({
        abortSignal: options.abortSignal,
        content: bufferToStream(buf),
        path: primitives.resolvePath(options.path),
      });
    },
    async removePath(options: SandboxRemovePathOptions) {
      await primitives.removePath({
        abortSignal: options.abortSignal,
        force: options.force,
        path: primitives.resolvePath(options.path),
        recursive: options.recursive,
      });
    },
    setNetworkPolicy,
  };
}

/**
 * Collects every chunk of a byte stream into a UTF-8 string. Mirrors
 * the standard `text()` shortcut on `Response` but works against the raw
 * `ReadableStream<Uint8Array>` shape that `Experimental_SandboxProcess`
 * exposes for stdout and stderr.
 */
async function collectStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const buf = await streamToBuffer(stream);
  return new TextDecoder().decode(buf);
}

/**
 * Validates the optional line-range options for
 * {@link SandboxSession.readTextFile}.
 *
 * Throws a descriptive error when values are non-integer, less than 1,
 * or when `startLine` exceeds `endLine`.
 */
function validateReadTextFileOptions(options: SandboxReadTextFileOptions): void {
  const { startLine, endLine } = options;
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    throw new Error("startLine must be a positive integer (1-based).");
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    throw new Error("endLine must be a positive integer (1-based).");
  }
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error("startLine must not be greater than endLine.");
  }
}

/**
 * Splits content into lines preserving original line endings.
 */
function splitLinesPreservingEndings(content: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\r") {
      if (i + 1 < content.length && content[i + 1] === "\n") {
        lines.push(content.slice(start, i + 2));
        start = i + 2;
        i++;
      } else {
        lines.push(content.slice(start, i + 1));
        start = i + 1;
      }
    } else if (content[i] === "\n") {
      lines.push(content.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < content.length) {
    lines.push(content.slice(start));
  }
  return lines;
}

/**
 * Returns the line-range slice of `content`, preserving original line
 * endings.
 */
function applyLineRange(content: string, options: SandboxReadTextFileOptions): string {
  if (options.startLine === undefined && options.endLine === undefined) {
    return content;
  }
  const lines = splitLinesPreservingEndings(content);
  const totalLines = lines.length;
  const startLine = options.startLine ?? 1;
  const endLine = Math.min(options.endLine ?? totalLines, totalLines);
  if (startLine > totalLines) {
    return "";
  }
  return lines.slice(startLine - 1, endLine).join("");
}

/**
 * Decodes raw bytes to a string using the given encoding.
 *
 * `"utf-8"` uses `TextDecoder` in fatal mode so malformed sequences
 * throw. Other encodings fall back to Node's `Buffer.toString`.
 */
function decodeBytes(buf: Uint8Array, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  }
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString(
    encoding as BufferEncoding,
  );
}

/**
 * Encodes a string to raw bytes using the given encoding.
 *
 * `"utf-8"` uses `TextEncoder`; other encodings fall back to
 * `Buffer.from(str, encoding)`.
 */
function encodeString(str: string, encoding: string): Uint8Array {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextEncoder().encode(str);
  }
  return Buffer.from(str, encoding as BufferEncoding);
}
