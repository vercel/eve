import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import {
  SandboxCommandOutcomeUnknownError,
  SandboxCommandRecoveryError,
} from "#execution/sandbox/command-errors.js";
import { isVercelCommandStreamInterruptedError } from "#execution/sandbox/bindings/vercel-errors.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";

/** Builds the eve sandbox primitives for one replaceable Vercel SDK handle. */
export function createVercelInternalSandboxSession(input: {
  readonly getSandbox: () => VercelSandbox;
  readonly id: string;
  readonly reattach?: () => Promise<void>;
}): InternalSandboxSession {
  return {
    id: input.id,
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const command = await input.getSandbox().runCommand({
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
        mapError: async (error) => await recoverInterruptedCommandStream(input, error),
      });
    },
    async readFile(options: SandboxReadFileOptions) {
      return normalizeVercelReadStream(await input.getSandbox().readFile({ path: options.path }));
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      await input.getSandbox().writeFiles([{ content: bytes, path: options.path }]);
    },
    async removePath(options: SandboxRemovePathOptions) {
      await input.getSandbox().fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
  };
}

async function recoverInterruptedCommandStream(
  input: { readonly reattach?: () => Promise<void> },
  error: unknown,
): Promise<unknown> {
  if (input.reattach === undefined || !isVercelCommandStreamInterruptedError(error)) {
    return error;
  }
  try {
    await input.reattach();
    return new SandboxCommandOutcomeUnknownError(error);
  } catch (recoveryError) {
    return new SandboxCommandRecoveryError({ commandError: error, recoveryError });
  }
}

function resolveVercelSandboxPath(path: string): string {
  return path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
}
