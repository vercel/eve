import type { SandboxProcess } from "#shared/sandbox-session.js";
import type { VercelCommand } from "#execution/sandbox/bindings/vercel-sdk-types.js";

/**
 * Wraps a Vercel `Command` (returned from `runCommand({ detached: true })`)
 * in the AI SDK `Experimental_SandboxProcess` shape.
 */
export function adaptVercelCommandToSandboxProcess(command: VercelCommand): SandboxProcess {
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
