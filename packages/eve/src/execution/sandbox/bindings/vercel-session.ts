import type { VercelEgressAuth } from "#execution/sandbox/bindings/vercel-egress-auth.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type { SandboxBackendHandle } from "#public/definitions/sandbox-backend.js";
import type { VercelSandboxSessionUseOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

export function createVercelSandboxHandle(
  sandbox: VercelSandbox,
  sessionKey: string,
  egressAuth: VercelEgressAuth | undefined,
  brokeredPolicy: SandboxNetworkPolicy | undefined,
): SandboxBackendHandle<VercelSandboxSessionUseOptions> {
  return {
    session: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey),
      createVercelNetworkPolicySetter(sandbox),
    ),
    useSessionFn: async (options?: VercelSandboxSessionUseOptions) => {
      if (options !== undefined) {
        if (egressAuth !== undefined && options.networkPolicy !== undefined) {
          throw new Error(
            "vercel(): `onSession` cannot replace `networkPolicy` when managed `auth` rules exist.",
          );
        }
        await sandbox.update(options);
      }
      if (brokeredPolicy !== undefined) {
        await sandbox.update({ networkPolicy: brokeredPolicy });
      }
      return buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, sessionKey),
        createVercelNetworkPolicySetter(sandbox),
      );
    },
    async captureState() {
      return {
        backendName: "vercel",
        metadata: { sandboxName: sandbox.name },
        sessionKey,
      };
    },
    async dispose() {
      if (egressAuth !== undefined) {
        await sandbox.update({ networkPolicy: egressAuth.clearedPolicy });
      }
    },
  };
}

export function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  id: string,
): InternalSandboxSession {
  return {
    id,
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

export function createVercelNetworkPolicySetter(
  sandbox: VercelSandbox,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    await sandbox.update({ networkPolicy: policy });
  };
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}
