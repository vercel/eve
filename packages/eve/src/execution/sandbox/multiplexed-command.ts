import type { SandboxProcess } from "#shared/sandbox-session.js";

type OutputName = "stderr" | "stdout";

interface MultiplexedCommand<Log extends { readonly data: string }> {
  kill(): PromiseLike<void>;
  logs(): AsyncIterable<Log>;
  wait(): PromiseLike<{ readonly exitCode: number }>;
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
 * with independent stdout and stderr streams.
 */
export function adaptMultiplexedCommandToSandboxProcess<
  Log extends { readonly data: string },
>(input: {
  readonly command: MultiplexedCommand<Log>;
  readonly getOutput: (log: Log) => OutputName;
  readonly mapError?: (error: unknown) => Promise<unknown> | unknown;
}): SandboxProcess {
  const encoder = new TextEncoder();
  const stdout = createOutputChannel();
  const stderr = createOutputChannel();
  const outputs: Record<OutputName, OutputChannel> = { stderr, stdout };
  let mappedError: Promise<unknown> | undefined;
  const mapError = (error: unknown): Promise<unknown> =>
    (mappedError ??= Promise.resolve(input.mapError?.(error) ?? error));

  const logsDone = (async () => {
    try {
      for await (const log of input.command.logs()) {
        outputs[input.getOutput(log)].enqueue(encoder.encode(log.data));
      }
      stdout.close();
      stderr.close();
    } catch (error) {
      const mapped = await mapError(error);
      stdout.error(mapped);
      stderr.error(mapped);
      throw mapped;
    }
  })();
  // The streams surface log failures immediately; retain the rejection for wait().
  void logsDone.catch(() => undefined);

  let waitPromise: Promise<{ exitCode: number }> | undefined;
  let killPromise: Promise<void> | undefined;

  return {
    stderr: stderr.stream,
    stdout: stdout.stream,
    wait() {
      return (waitPromise ??= Promise.resolve()
        .then(async () => {
          const finished = await input.command.wait();
          await logsDone;
          return { exitCode: finished.exitCode };
        })
        .catch(async (error: unknown) => {
          throw await mapError(error);
        }));
    },
    kill() {
      return (killPromise ??= Promise.resolve().then(() => input.command.kill()));
    },
  };
}
