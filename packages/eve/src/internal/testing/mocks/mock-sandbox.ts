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
  SandboxWriteFilesOptions,
  SandboxWriteTextFileOptions,
} from "#public/definitions/sandbox.js";
import { posix } from "node:path";

import type { SandboxConnection } from "#sandbox/provider.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
type NetworkPolicySandboxSession = SandboxSession & {
  readonly name: string;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

interface MockSandboxInput {
  readonly delete?: () => Promise<void> | void;
  readonly id?: string;
  readonly name?: string;
  readonly initialFiles?: Readonly<Record<string, string>>;
  readonly commands?: Readonly<Record<string, SandboxCommandResult>>;
  readonly run?: (
    options: SandboxRunOptions,
  ) => Promise<SandboxCommandResult> | SandboxCommandResult;
  readonly stop?: () => Promise<void> | void;
}

export interface MockSandboxWrite {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface MockSandbox {
  readonly access: SandboxAccess;
  readonly session: NetworkPolicySandboxSession;
  readonly connection: SandboxConnection<Pick<NetworkPolicySandboxSession, "setNetworkPolicy">>;
  readonly commandLog: readonly string[];
  readonly removedPaths: readonly string[];
  readonly networkPolicyUpdates: readonly SandboxNetworkPolicy[];
  readonly files: Map<string, string>;
  readonly fileBytes: Map<string, Buffer>;
  readonly writes: readonly MockSandboxWrite[];
}

export function mockSandbox(input: MockSandboxInput = {}): MockSandbox {
  const files = new Map<string, string>();
  const fileBytes = new Map<string, Buffer>();
  const modified = new Map<string, number>();
  let clock = 0;
  const writes: MockSandboxWrite[] = [];
  const commandLog: string[] = [];
  const removedPaths: string[] = [];
  const networkPolicyUpdates: SandboxNetworkPolicy[] = [];

  for (const [path, contents] of Object.entries(input.initialFiles ?? {})) {
    const resolved = resolveWorkspacePath(path);
    files.set(resolved, contents);
    fileBytes.set(resolved, Buffer.from(contents, "utf8"));
  }

  async function defaultRun(options: SandboxRunOptions): Promise<SandboxCommandResult> {
    const existsMatch = /^test -e '((?:[^']|'\\'')*)'$/.exec(options.command);
    if (existsMatch !== null) {
      const target = resolveWorkspacePath(existsMatch[1]!.replaceAll("'\\''", "'"));
      const exists = files.has(target) || fileBytes.has(target);
      return { exitCode: exists ? 0 : 1, stderr: "", stdout: "" };
    }
    const find =
      /^find (\S+) -maxdepth 1 -type f -exec (?:stat -c '%Y %s %n' \{\} \+ 2>\/dev\/null|sh -c 'stat -c "%Y %s %n" (?:-- )?"\$@" 2>\/dev\/null \|\| stat -f "%m %z %N" (?:-- )?"\$@" 2>\/dev\/null' _ \{\} \+) \| head -c (\d+)$/.exec(
        options.command,
      );
    if (find !== null) {
      const prefix = `${find[1]}/`;
      const lines = [...fileBytes]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => `${modified.get(path) ?? 0} ${bytes.byteLength} ${path}`);
      const listing = lines.map((line) => `${line}\n`).join("");
      return { exitCode: 0, stderr: "", stdout: listing.slice(0, Number(find[2])) };
    }
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

    return await defaultRun(options);
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

  async function writeBinaryFile(options: SandboxWriteBinaryFileOptions): Promise<void> {
    const resolved = resolveWorkspacePath(options.path);
    writes.push({ content: options.content, path: resolved });
    const buf = Buffer.from(
      options.content.buffer,
      options.content.byteOffset,
      options.content.byteLength,
    );
    files.set(resolved, buf.toString("utf8"));
    fileBytes.set(resolved, buf);
    modified.set(resolved, (clock += 1));
  }

  const baseSession: NetworkPolicySandboxSession = {
    name: input.name ?? "sbx_mock",
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
      modified.set(resolved, (clock += 1));
    },
    writeBinaryFile,
    async writeFiles(options: SandboxWriteFilesOptions): Promise<void> {
      for (const file of options.files) await writeBinaryFile(file);
    },
    async writeTextFile(options: SandboxWriteTextFileOptions): Promise<void> {
      const resolved = resolveWorkspacePath(options.path);
      writes.push({ content: options.content, path: resolved });
      files.set(resolved, options.content);
      fileBytes.set(resolved, Buffer.from(options.content, "utf8"));
      modified.set(resolved, (clock += 1));
    },
  };
  const session = baseSession;
  const connection: MockSandbox["connection"] = {
    extensions: { setNetworkPolicy: session.setNetworkPolicy },
    readFile: async ({ path }) => fileBytes.get(path) ?? null,
    removePath,
    spawn: async (options) => await session.spawn(options),
    async stop() {
      await input.stop?.();
    },
    writeFiles: async (options) => await session.writeFiles(options),
  };

  let preparations: Promise<unknown> = Promise.resolve();
  const access: SandboxAccess = {
    async captureState(): Promise<SandboxState> {
      return { session: null };
    },
    async delete(): Promise<void> {
      await input.delete?.();
    },
    async get(): Promise<NetworkPolicySandboxSession> {
      await preparations;
      return session;
    },
    async open(): Promise<NetworkPolicySandboxSession> {
      return session;
    },
    prepare(work) {
      preparations = preparations.then(() => work?.(async () => session)).catch(() => undefined);
    },
    async stop(): Promise<void> {
      await input.stop?.();
    },
  };

  return {
    access,
    commandLog,
    connection,
    fileBytes,
    files,
    networkPolicyUpdates,
    removedPaths,
    session,
    writes,
  };
}

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

function resolveWorkspacePath(path: string): string {
  return posix.resolve(WORKSPACE_ROOT, path);
}
