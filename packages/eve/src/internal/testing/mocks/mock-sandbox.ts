import type {
  SandboxCommandResult,
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
} from "#public/definitions/sandbox.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";

/**
 * Declarative description of a mock sandbox surface.
 *
 * Mock sandboxes capture every interaction in-memory: `writeFile` stores
 * bytes, `readFile` returns previously stored content, and `run`
 * dispatches to a declarative stub map (or a user-supplied default
 * handler). Tests can read the captured state off the returned
 * `MockSandbox` after running a tool to assert on ordering, arguments,
 * or file contents without touching disk or spawning processes.
 */
export interface MockSandboxInput {
  /**
   * Stable sandbox identifier. Defaults to `"sbx_mock"`.
   */
  readonly id?: string;
  /**
   * Initial file contents visible to the sandbox.
   *
   * Keys are paths (relative paths are anchored under `/workspace`, matching
   * the real public-surface contract).
   */
  readonly initialFiles?: Readonly<Record<string, string>>;
  /**
   * Pre-registered command responses keyed by the exact command string. The
   * first matching entry for a `run({ command })` call wins. Missing keys
   * fall through to {@link MockSandboxInput.run}.
   */
  readonly commands?: Readonly<Record<string, SandboxCommandResult>>;
  /**
   * Fallback command handler. Invoked when the request does not match a
   * {@link MockSandboxInput.commands} entry. Defaults to a no-op exit code 0
   * handler with empty stdout/stderr.
   */
  readonly run?: (
    options: SandboxRunOptions,
  ) => Promise<SandboxCommandResult> | SandboxCommandResult;
}

/**
 * One write observed by {@link MockSandbox} with the exact `content`
 * argument preserved. Binary payloads (`Uint8Array`) are kept as-is so
 * tests that care about byte fidelity (attachment staging, file upload
 * pipelines) can assert on the raw bytes.
 */
export interface MockSandboxWrite {
  readonly path: string;
  readonly content: string | Uint8Array;
}

/**
 * A materialized mock sandbox returned from {@link mockSandbox}.
 *
 * Exposes the `SandboxAccess` object expected by context plumbing plus
 * inspection affordances (`commandLog`, `files`, `writes`) that tests
 * assert against.
 */
export interface MockSandbox {
  /** Drop-in `SandboxAccess` suitable for `ctx.set(SandboxKey, ...)`. */
  readonly access: SandboxAccess;
  /**
   * Direct handle to the underlying sandbox session. Exposed for tests that
   * want to call the session surface outside a `ctx` scope.
   */
  readonly session: SandboxSession;
  /** Ordered log of every command received through `run`/`spawn`. */
  readonly commandLog: readonly string[];
  /** Ordered log of every path received through `removePath`. */
  readonly removedPaths: readonly string[];
  /** Ordered log of every network policy applied via `setNetworkPolicy`. */
  readonly networkPolicyUpdates: readonly SandboxNetworkPolicy[];
  /**
   * Mutable map of current file contents. Binary writes are stored as
   * the UTF-8 decoding of the bytes; use {@link MockSandbox.writes} for
   * byte-exact assertions.
   */
  readonly files: Map<string, string>;
  /**
   * Mutable map of the exact bytes observed on the most recent write
   * for each resolved path. Populated for every `writeFile` call and
   * consumed by {@link SandboxAccess.readFileBytes} on the mock
   * `access` so attachment hydration sees byte-for-byte identical
   * content.
   */
  readonly fileBytes: Map<string, Buffer>;
  /**
   * Ordered log of every write received through `writeFile`, preserving
   * the exact `content` argument (including `Uint8Array` payloads) so
   * tests can assert byte-level fidelity.
   */
  readonly writes: readonly MockSandboxWrite[];
}

/**
 * Builds an in-memory {@link MockSandbox} from a declarative descriptor.
 */
export function mockSandbox(input: MockSandboxInput = {}): MockSandbox {
  const sandboxId = input.id ?? "sbx_mock";
  const files = new Map<string, string>();
  const fileBytes = new Map<string, Buffer>();
  const writes: MockSandboxWrite[] = [];
  const commandLog: string[] = [];
  const removedPaths: string[] = [];
  const networkPolicyUpdates: SandboxNetworkPolicy[] = [];

  for (const [path, contents] of Object.entries(input.initialFiles ?? {})) {
    const resolved = resolveWorkspacePath(path);
    files.set(resolved, contents);
    fileBytes.set(resolved, Buffer.from(contents, "utf8"));
  }

  async function defaultRun(): Promise<SandboxCommandResult> {
    return { exitCode: 0, stderr: "", stdout: "" };
  }

  async function run(options: SandboxRunOptions): Promise<SandboxCommandResult> {
    commandLog.push(options.command);

    const stub = input.commands?.[options.command];

    if (stub !== undefined) {
      return stub;
    }

    const fallback = input.run;
    if (fallback !== undefined) {
      return await fallback(options);
    }

    return await defaultRun();
  }

  async function removePath(options: SandboxRemovePathOptions): Promise<void> {
    const resolved = resolveWorkspacePath(options.path);
    removedPaths.push(resolved);

    if (options.recursive) {
      const prefix = resolved.endsWith("/") ? resolved : `${resolved}/`;
      let removed = false;
      for (const path of files.keys()) {
        if (path === resolved || path.startsWith(prefix)) {
          files.delete(path);
          fileBytes.delete(path);
          removed = true;
        }
      }
      if (!removed && !options.force) {
        throw new Error(`ENOENT: no such file or directory, rm '${resolved}'`);
      }
      return;
    }

    const removed = files.delete(resolved);
    fileBytes.delete(resolved);
    if (!removed && !options.force) {
      throw new Error(`ENOENT: no such file or directory, rm '${resolved}'`);
    }
  }

  const session: SandboxSession = {
    id: sandboxId,
    resolvePath(path: string): string {
      return resolveWorkspacePath(path);
    },
    async setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
      networkPolicyUpdates.push(policy);
    },
    async run(options: SandboxRunOptions): Promise<SandboxCommandResult> {
      return await run(options);
    },
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const result = await run(options);
      return synthesizeMockProcess(result);
    },
    async readFile(options: SandboxReadFileOptions): Promise<ReadableStream<Uint8Array> | null> {
      const buf = fileBytes.get(resolveWorkspacePath(options.path));
      return buf === undefined ? null : bufferToStream(buf);
    },
    async removePath(options: SandboxRemovePathOptions): Promise<void> {
      await removePath(options);
    },
    async readBinaryFile(options: SandboxReadBinaryFileOptions): Promise<Uint8Array | null> {
      return fileBytes.get(resolveWorkspacePath(options.path)) ?? null;
    },
    async readTextFile(options: SandboxReadTextFileOptions): Promise<string | null> {
      const content = files.get(resolveWorkspacePath(options.path));

      if (content === undefined) {
        return null;
      }

      if (options.startLine === undefined && options.endLine === undefined) {
        return content;
      }

      const lines = content.split("\n");
      const startLine = options.startLine ?? 1;
      const endLine = options.endLine ?? lines.length;

      return lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
    },
    async writeFile(options: SandboxWriteFileOptions): Promise<void> {
      const resolved = resolveWorkspacePath(options.path);
      const buf = await streamToBuffer(options.content);
      writes.push({ content: buf, path: resolved });
      files.set(resolved, buf.toString("utf8"));
      fileBytes.set(resolved, buf);
    },
    async writeBinaryFile(options: SandboxWriteBinaryFileOptions): Promise<void> {
      const resolved = resolveWorkspacePath(options.path);
      writes.push({ content: options.content, path: resolved });
      const buf = Buffer.from(
        options.content.buffer,
        options.content.byteOffset,
        options.content.byteLength,
      );
      files.set(resolved, buf.toString("utf8"));
      fileBytes.set(resolved, buf);
    },
    async writeTextFile(options: SandboxWriteTextFileOptions): Promise<void> {
      const resolved = resolveWorkspacePath(options.path);
      writes.push({ content: options.content, path: resolved });
      files.set(resolved, options.content);
      fileBytes.set(resolved, Buffer.from(options.content, "utf8"));
    },
  };

  const access: SandboxAccess = {
    async captureState(): Promise<SandboxState> {
      return {
        initialized: false,
        session: null,
      };
    },
    async get(): Promise<SandboxSession> {
      return session;
    },
  };

  return {
    access,
    commandLog,
    fileBytes,
    files,
    networkPolicyUpdates,
    removedPaths,
    session,
    writes,
  };
}

/**
 * Wraps a pre-materialized {@link SandboxCommandResult} in a synthetic
 * {@link SandboxProcess} so the mock `spawn` path can satisfy the same
 * shape live backends expose.
 */
function synthesizeMockProcess(result: SandboxCommandResult): SandboxProcess {
  const encoder = new TextEncoder();
  return {
    stdout: bufferToStream(encoder.encode(result.stdout)),
    stderr: bufferToStream(encoder.encode(result.stderr)),
    async wait() {
      return { exitCode: result.exitCode };
    },
    async kill() {},
  };
}

/**
 * Anchors a sandbox-relative path under `/workspace`, mirroring the real
 * backend contract documented on {@link SandboxSession.resolvePath}.
 */
function resolveWorkspacePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }

  return `/workspace/${path}`;
}
