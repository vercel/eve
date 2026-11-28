import { posix } from "node:path";

import type { SandboxConnection } from "#sandbox/provider.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type {
  SandboxCommandResult,
  SandboxProcess,
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
import {
  getConnectionFastPaths,
  withSessionFastPaths,
  type InternalCommandOptions,
} from "#execution/sandbox/internal-shell.js";
import { bufferToStream, streamToBuffer } from "./stream-utils.js";

const MAX_INTERNAL_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Tells agent-aware CLIs (such as `vercel`) that an automated agent runs
 * the command, so they skip interactive prompts. Providers apply it beneath
 * environment-level and per-call env so authors can override it.
 */
export const SANDBOX_AGENT_ENV: Readonly<Record<string, string>> = { AI_AGENT: "eve" };

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
  async function read(options: { readonly signal?: AbortSignal; readonly path: string }) {
    return await connection.readFile({
      signal: options.signal,
      path: resolveSandboxPath(options.path),
    });
  }
  async function readBytes(options: { readonly signal?: AbortSignal; readonly path: string }) {
    const content = await read(options);
    if (content === null) return null;
    return ArrayBuffer.isView(content) ? Buffer.from(content) : await streamToBuffer(content);
  }
  async function write(
    options: { readonly signal?: AbortSignal; readonly path: string },
    content: Uint8Array,
  ) {
    await connection.writeFiles({
      signal: options.signal,
      files: [{ content, path: resolveSandboxPath(options.path) }],
    });
  }
  async function spawn(options: SandboxSpawnOptions) {
    const process = await connection.spawn({
      signal: options.signal,
      stdin: options.stdin,
      command: options.command,
      env: options.env ?? {},
      workingDirectory: resolveSandboxPath(options.workingDirectory ?? "."),
    });
    if (options.stdin === true && process.stdin === undefined) {
      await Promise.resolve(process.kill()).catch(() => undefined);
      throw new Error("This sandbox provider does not support `stdin` on spawn.");
    }
    return process;
  }
  const fastPaths = getConnectionFastPaths(connection);
  const session: SandboxSession = {
    resolvePath: resolveSandboxPath,
    async run(options: SandboxRunOptions) {
      if (fastPaths?.runLogin !== undefined) {
        return await fastPaths.runLogin({
          command: options.command,
          env: options.env ?? {},
          signal: options.signal,
          workingDirectory: resolveSandboxPath(options.workingDirectory ?? "."),
        });
      }
      return await runSpawnedCommand(spawn, options);
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
        signal: options.signal,
        files: options.files.map((file) => ({
          content: file.content,
          path: resolveSandboxPath(file.path),
        })),
      });
    },
    async removePath(options: SandboxRemovePathOptions) {
      await connection.removePath({
        signal: options.signal,
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
  const combined = { ...extensions, ...session } as SandboxSession & Extensions;
  const connectionJobsRoot = fastPaths?.jobsRoot;
  const connectionRunFast = fastPaths?.runFast;
  const connectionSkillsRoot = fastPaths?.skillsRoot;
  const connectionSpawnBounded = fastPaths?.spawnBounded;
  if (connectionJobsRoot !== undefined && !posix.isAbsolute(connectionJobsRoot)) {
    throw new Error(
      `Sandbox connection jobsRoot must be an absolute path, but received "${connectionJobsRoot}".`,
    );
  }
  if (connectionSkillsRoot !== undefined && !posix.isAbsolute(connectionSkillsRoot)) {
    throw new Error(
      `Sandbox connection skillsRoot must be an absolute path, but received "${connectionSkillsRoot}".`,
    );
  }
  withSessionFastPaths(combined, {
    ...(connectionJobsRoot !== undefined && { jobsRoot: connectionJobsRoot }),
    runFast: async (options: InternalCommandOptions) => {
      if (connectionRunFast !== undefined) {
        const result = await connectionRunFast({
          command: options.command,
          env: options.env ?? {},
          signal: options.signal,
          workingDirectory: resolveSandboxPath(options.workingDirectory ?? "."),
        });
        if (options.maxOutputBytes !== undefined) {
          const maxBytes = resolveInternalMaxOutputBytes(options.maxOutputBytes);
          if (
            Buffer.byteLength(result.stdout) > maxBytes ||
            Buffer.byteLength(result.stderr) > maxBytes
          ) {
            throw new Error(`Sandbox internal command output exceeded the ${maxBytes}-byte limit.`);
          }
        }
        return result;
      }
      return await runSpawnedCommand(
        spawn,
        options,
        resolveInternalMaxOutputBytes(options.maxOutputBytes),
      );
    },
    ...(connectionSkillsRoot !== undefined && { skillsRoot: connectionSkillsRoot }),
    ...(connectionSpawnBounded !== undefined && {
      spawnBounded: async (options) =>
        await connectionSpawnBounded({
          command: options.command,
          env: options.env ?? {},
          signal: options.signal,
          workingDirectory: resolveSandboxPath(options.workingDirectory ?? "."),
        }),
    }),
  });
  return combined;
}

function resolveInternalMaxOutputBytes(requested: number | undefined): number {
  if (requested === undefined) return MAX_INTERNAL_COMMAND_OUTPUT_BYTES;
  return Math.min(Math.max(1, Math.floor(requested)), MAX_INTERNAL_COMMAND_OUTPUT_BYTES);
}

async function runSpawnedCommand(
  spawn: (options: SandboxSpawnOptions) => Promise<SandboxProcess>,
  options: SandboxRunOptions,
  maxOutputBytes?: number,
): Promise<SandboxCommandResult> {
  const process = await spawn(options);
  let overflowed = false;
  const onOverflow =
    maxOutputBytes === undefined
      ? undefined
      : () => {
          if (overflowed) return;
          overflowed = true;
          void Promise.resolve(process.kill()).catch(() => undefined);
        };
  const [stdout, stderr, { exitCode }] = await Promise.all([
    collectStreamToString(process.stdout, maxOutputBytes, onOverflow),
    collectStreamToString(process.stderr, maxOutputBytes, onOverflow),
    process.wait(),
  ]);
  if (overflowed) {
    throw new Error(`Sandbox internal command output exceeded the ${maxOutputBytes}-byte limit.`);
  }
  return { exitCode, stderr, stdout };
}

async function collectStreamToString(
  stream: ReadableStream<Uint8Array>,
  maxBytes?: number,
  onOverflow?: () => void,
): Promise<string> {
  const buf = await streamToBuffer(
    stream,
    maxBytes === undefined ? undefined : { maxBytes, onOverflow },
  );
  return new TextDecoder().decode(buf);
}

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

function decodeBytes(buf: Uint8Array, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  }
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString(
    encoding as BufferEncoding,
  );
}
