import type {
  Sandbox as SdkSandbox,
  SandboxCommand as SdkSandboxCommand,
} from "#compiled/@vercel/sandbox/index.js";

import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";

export function createVercelInternalSandboxSession(
  sandbox: SdkSandbox,
  id: string,
  ports: ReadonlyArray<number> | undefined,
): InternalSandboxSession {
  return {
    id,
    getPortUrl(port: number) {
      if (ports?.includes(port) !== true) {
        throw new Error(`Sandbox port ${String(port)} is not published.`);
      }
      return sandbox.domain(port);
    },
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
      return adaptVercelCommandToSandboxProcess(command);
    },
    async readFile(options: SandboxReadFileOptions) {
      const stream = await sandbox.readFile({ path: options.path });
      return stream ?? null;
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

/** Adapts one detached Vercel command to Eve's streamed process contract. */
function adaptVercelCommandToSandboxProcess(command: SdkSandboxCommand): SandboxProcess {
  const encoder = new TextEncoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamingDone = false;
  let streamingError: unknown;

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  void (async () => {
    try {
      for await (const message of command.logs()) {
        const chunk = encoder.encode(message.data);
        if (message.stream === "stdout") {
          stdoutController?.enqueue(chunk);
        } else {
          stderrController?.enqueue(chunk);
        }
      }
    } catch (error) {
      streamingError = error;
      stdoutController?.error(error);
      stderrController?.error(error);
    } finally {
      streamingDone = true;
      if (streamingError === undefined) {
        stdoutController?.close();
        stderrController?.close();
      }
    }
  })();

  return {
    stdout,
    stderr,
    async wait() {
      const finished = await command.wait();
      while (!streamingDone) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (streamingError !== undefined) {
        throw streamingError;
      }
      return { exitCode: finished.exitCode };
    },
    async kill() {
      await command.kill();
    },
  };
}

function resolveVercelSandboxPath(path: string): string {
  return path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
}
