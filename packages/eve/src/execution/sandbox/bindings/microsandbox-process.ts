import type { SandboxProcess } from "#shared/sandbox-session.js";
import type { ExecHandle as MicrosandboxExecHandle } from "microsandbox";

const MICROSANDBOX_EXEC_POST_EXIT_DRAIN_MS = 100;

export function adaptMicrosandboxExecToSandboxProcess(
  command: MicrosandboxExecHandle,
): SandboxProcess {
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let exitCode: number | undefined;
  let resolveFinished: (() => void) | undefined;
  let rejectFinished: ((error: unknown) => void) | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

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
    const iterator = command[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result =
          exitCode === undefined
            ? await iterator.next()
            : await nextWithTimeout(iterator, MICROSANDBOX_EXEC_POST_EXIT_DRAIN_MS);
        if (result === "timeout" || result.done === true) {
          break;
        }

        const event = result.value;
        if (event.kind === "stdout") {
          stdoutController?.enqueue(event.data);
        } else if (event.kind === "stderr") {
          stderrController?.enqueue(event.data);
        } else if (event.kind === "exited") {
          exitCode = event.code;
        }
      }
    } catch (error) {
      stdoutController?.error(error);
      stderrController?.error(error);
      rejectFinished?.(error);
    } finally {
      void iterator.return?.().catch(() => {});
      if (exitCode === undefined) {
        const error = new Error("Microsandbox command ended without an exit event.");
        stdoutController?.error(error);
        stderrController?.error(error);
        rejectFinished?.(error);
      } else {
        stdoutController?.close();
        stderrController?.close();
        resolveFinished?.();
      }
    }
  })();

  return {
    stdout,
    stderr,
    async wait() {
      await finished;
      return { exitCode: exitCode ?? 0 };
    },
    async kill() {
      await command.kill();
    },
  };
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T> | "timeout"> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
