import { posix } from "node:path";

import type { SandboxConnection } from "#sandbox/provider.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type {
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxReadTextFileOptions,
  SandboxRemovePathOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteFilesOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";
import { bufferToStream, streamToBuffer } from "./stream-utils.js";

/**
 * Tells agent-aware CLIs (such as `vercel`) that an automated agent runs
 * the command, so they skip interactive prompts. Providers apply it beneath
 * environment-level and per-call env so authors can override it.
 */
export const SANDBOX_AGENT_ENV: Readonly<Record<string, string>> = { AI_AGENT: "eve" };

/**
 * Builds the {@link SandboxSession} eve hands out from a provider's
 * connection: every path and working directory resolves from the
 * connection's workspace root, `run` collects `spawn`, the read and write
 * variants share the connection's byte primitives, and the connection's
 * extensions merge on top.
 */
export function createConnectionSession<Extensions extends object>(
  connection: SandboxConnection<Extensions>,
): SandboxSession & Extensions {
  const workspaceRoot = connection.workspaceRoot ?? WORKSPACE_ROOT;
  if (!posix.isAbsolute(workspaceRoot)) {
    throw new Error(
      `Sandbox connection workspaceRoot must be an absolute path, but received "${workspaceRoot}".`,
    );
  }
  const resolveSandboxPath = (path: string) => posix.resolve(workspaceRoot, path);
  async function read(options: { readonly abortSignal?: AbortSignal; readonly path: string }) {
    return await connection.readFile({
      abortSignal: options.abortSignal,
      path: resolveSandboxPath(options.path),
    });
  }
  async function readBytes(options: { readonly abortSignal?: AbortSignal; readonly path: string }) {
    const content = await read(options);
    if (content === null) return null;
    return ArrayBuffer.isView(content) ? Buffer.from(content) : await streamToBuffer(content);
  }
  async function write(
    options: { readonly abortSignal?: AbortSignal; readonly path: string },
    content: Uint8Array,
  ) {
    await connection.writeFiles({
      abortSignal: options.abortSignal,
      files: [{ content, path: resolveSandboxPath(options.path) }],
    });
  }
  async function spawn(options: SandboxSpawnOptions) {
    return await connection.spawn({
      abortSignal: options.abortSignal,
      command: options.command,
      env: options.env ?? {},
      workingDirectory: resolveSandboxPath(options.workingDirectory ?? "."),
    });
  }
  const session: SandboxSession = {
    resolvePath: resolveSandboxPath,
    async run(options: SandboxRunOptions) {
      const process = await spawn(options);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collectStreamToString(process.stdout),
        collectStreamToString(process.stderr),
        process.wait(),
      ]);
      return { exitCode, stderr, stdout };
    },
    spawn,
    async readFile(options: SandboxReadFileOptions) {
      const content = await read(options);
      if (content === null || !ArrayBuffer.isView(content)) return content;
      return bufferToStream(new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
    },
    readBinaryFile: (options: SandboxReadBinaryFileOptions) => readBytes(options),
    async readTextFile(options: SandboxReadTextFileOptions) {
      validateReadTextFileOptions(options);
      const content = await readBytes(options);
      if (content === null) return null;
      return applyLineRange(decodeBytes(content, options.encoding ?? "utf-8"), options);
    },
    async writeFile(options: SandboxWriteFileOptions) {
      await write(options, await streamToBuffer(options.content));
    },
    async writeBinaryFile(options: SandboxWriteBinaryFileOptions) {
      await write(options, Buffer.from(options.content));
    },
    async writeTextFile(options: SandboxWriteTextFileOptions) {
      const encoding = (options.encoding ?? "utf-8") as BufferEncoding;
      await write(options, Buffer.from(options.content, encoding));
    },
    async writeFiles(options: SandboxWriteFilesOptions) {
      await connection.writeFiles({
        abortSignal: options.abortSignal,
        files: options.files.map((file) => ({
          content: file.content,
          path: resolveSandboxPath(file.path),
        })),
      });
    },
    async removePath(options: SandboxRemovePathOptions) {
      await connection.removePath({
        abortSignal: options.abortSignal,
        force: options.force,
        path: resolveSandboxPath(options.path),
        recursive: options.recursive,
      });
    },
  };
  const extensions: object = connection.extensions ?? {};
  const collisions = Object.keys(extensions).filter(
    (key) => Object.hasOwn(session, key) || key === "delete" || key === "stop",
  );
  if (collisions.length > 0) {
    throw new Error(
      `Sandbox connection extensions cannot replace the session members eve provides: ${collisions.join(", ")}. Rename them.`,
    );
  }
  return { ...extensions, ...session } as SandboxSession & Extensions;
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
