import type { SandboxProcess } from "#shared/sandbox-session.js";

type OutputName = "stderr" | "stdout";

interface MultiplexedCommand<Log extends { readonly data: string }> {
  kill(): PromiseLike<void>;
  logs(options: { readonly signal?: AbortSignal }): AsyncIterable<Log>;
  wait(options: { readonly signal?: AbortSignal }): PromiseLike<{ readonly exitCode: number }>;
}

interface OutputChannel {
  readonly stream: ReadableStream<Uint8Array>;
  close(): void;
  enqueue(chunk: Uint8Array): void;
  error(cause: unknown): void;
}

function createOutputChannel(): OutputChannel {
  let canceled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
    start(value) {
      controller = value;
    },
  });

  return {
    stream,
    close() {
      if (!canceled) {
        controller.close();
      }
    },
    enqueue(chunk) {
      if (!canceled) {
        controller.enqueue(chunk);
      }
    },
    error(cause) {
      if (!canceled) {
        controller.error(cause);
      }
    },
  };
}

/**
 * Adapts a detached command with one tagged log iterator to a sandbox process
 * with independent stdout and stderr streams. Aborting `abortSignal` kills the
 * command and rejects `wait()` and both streams.
 */
export function adaptMultiplexedCommandToSandboxProcess<
  Log extends { readonly data: string },
>(input: {
  readonly abortSignal?: AbortSignal;
  readonly command: MultiplexedCommand<Log>;
  readonly getOutput: (log: Log) => OutputName;
}): SandboxProcess {
  const { abortSignal: signal, command } = input;
  const encoder = new TextEncoder();
  const stdout = createOutputChannel();
  const stderr = createOutputChannel();
  const outputs: Record<OutputName, OutputChannel> = { stderr, stdout };

  const logsDone = (async () => {
    try {
      for await (const log of command.logs({ signal })) {
        outputs[input.getOutput(log)].enqueue(encoder.encode(log.data));
      }
      stdout.close();
      stderr.close();
    } catch (error) {
      // The SDK aborts its log request without the caller's abort reason.
      const cause = signal?.aborted ? signal.reason : error;
      stdout.error(cause);
      stderr.error(cause);
      throw cause;
    }
  })();

  let waitPromise: Promise<{ exitCode: number }> | undefined;
  let killPromise: Promise<void> | undefined;
  const kill = () => (killPromise ??= Promise.resolve().then(() => command.kill()));

  // A detached command outlives the signal that started it. The kill is
  // best-effort: the command may already be gone.
  const killOnAbort = () => void kill().catch(() => undefined);
  const disarmKill = () => signal?.removeEventListener("abort", killOnAbort);
  if (signal?.aborted) killOnAbort();
  signal?.addEventListener("abort", killOnAbort, { once: true });
  // Logs end when the command exits. A failed log stream says nothing about
  // the command, so the kill stays armed. The streams surface log failures
  // immediately; retain the rejection for wait().
  void logsDone.then(disarmKill, () => undefined);

  return {
    stderr: stderr.stream,
    stdout: stdout.stream,
    wait() {
      return (waitPromise ??= Promise.resolve().then(async () => {
        const finished = await command.wait({ signal });
        disarmKill();
        await logsDone;
        return { exitCode: finished.exitCode };
      }));
    },
    kill,
  };
}
