import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export function createVercelSandboxSession(
  sandbox: VercelSandbox,
  sessionKey: string,
): SandboxSession {
  return buildSandboxSession(
    createVercelInternalSandboxSession(sandbox, sessionKey),
    createVercelNetworkPolicySetter(sandbox),
  );
}

export function createVercelNetworkPolicySetter(
  sandbox: VercelSandbox,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    await sandbox.update({ networkPolicy: policy });
  };
}

export function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  id: string,
): InternalSandboxSession {
  return {
    id,
    resolvePath(path) {
      if (path.startsWith("/")) {
        return path;
      }
      return `${WORKSPACE_ROOT}/${path}`;
    },
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
      await sandbox.writeFiles([{ content: bytes, path: options.path }]);
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

export async function stopVercelSandbox(sandbox: VercelSandbox): Promise<void> {
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return;
  }
  try {
    await sandbox.stop();
  } catch {
    // Best-effort: an unreachable or already-stopped sandbox must not
    // block server shutdown; the provider-side timeout is the backstop.
  }
}
