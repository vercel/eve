import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";

/** Adapts a Vercel SDK sandbox to eve's internal sandbox session surface. */
export function createVercelInternalSandboxSession(sandbox: VercelSandbox): InternalSandboxSession {
  return {
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await sandbox.runCommand({
        args: ["-lc", options.command],
        cmd: "bash",
        cwd: options.workingDirectory ?? WORKSPACE_ROOT,
        detached: true,
        env: options.env,
        signal: options.abortSignal,
      });
      return adaptMultiplexedCommandToSandboxProcess({
        command,
        getOutput: (log) => log.stream,
      });
    },
    async readFile(options: SandboxReadFileOptions) {
      return normalizeVercelReadStream(await sandbox.readFile({ path: options.path }));
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      const path = await resolveVercelWritePath(sandbox, options.path, options.abortSignal);
      await sandbox.writeFiles([{ content: bytes, path }], { signal: options.abortSignal });
    },
    async removePath(options: SandboxRemovePathOptions) {
      await sandbox.fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
  };
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}

async function resolveVercelWritePath(
  sandbox: VercelSandbox,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await sandbox.runCommand({
    args: ["-m", "--", path],
    cmd: "realpath",
    signal,
  });
  const resolved = (await result.stdout()).trim();
  if (result.exitCode !== 0 || !resolved.startsWith("/") || resolved.includes("\n")) {
    throw new Error(`Failed to resolve Vercel Sandbox write path: ${path}`);
  }
  return resolved;
}
