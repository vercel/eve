import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import type {
  ManagedSandboxCommandBackend,
  ManagedSandboxCommandBackendProcess,
} from "#execution/sandbox/managed-command.js";
import { isVercelSandboxMissingError } from "#execution/sandbox/bindings/vercel-errors.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

export function createVercelManagedCommandBackend(
  sandbox: VercelSandbox,
): ManagedSandboxCommandBackend {
  return {
    async start(command) {
      const started = await sandbox.runCommand({
        args: ["-lc", command],
        cmd: "bash",
        cwd: WORKSPACE_ROOT,
        detached: true,
      });
      return adaptVercelManagedCommand(started);
    },
    async reconnect(commandId) {
      try {
        return adaptVercelManagedCommand(await sandbox.getCommand(commandId));
      } catch (error) {
        if (isVercelSandboxMissingError(error)) return null;
        throw error;
      }
    },
  };
}

function adaptVercelManagedCommand(
  command: Awaited<ReturnType<VercelSandbox["getCommand"]>>,
): ManagedSandboxCommandBackendProcess {
  return {
    commandId: command.cmdId,
    process: adaptMultiplexedCommandToSandboxProcess({
      command,
      getOutput: (log) => log.stream,
    }),
  };
}
