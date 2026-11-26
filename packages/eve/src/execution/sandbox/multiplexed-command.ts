import { Writable } from "node:stream";

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

function createChannelWritable(channel: OutputChannel): Writable {
  const writable = new Writable({
    write(chunk: Buffer | Uint8Array | string, encoding, callback) {
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk, encoding as BufferEncoding)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      channel.enqueue(bytes);
      callback();
    },
  });
  writable.on("error", () => undefined);
  return writable;
}

interface StdinCommand {
  closeStdin(options: { readonly abortSignal?: AbortSignal }): PromiseLike<void>;
  writeStdin(data: Uint8Array, options: { readonly abortSignal?: AbortSignal }): PromiseLike<void>;
}

function createStdinStream(
  command: StdinCommand,
  signals: readonly AbortSignal[],
): WritableStream<Uint8Array> {
  let abortSignal: AbortSignal | undefined;
  return new WritableStream<Uint8Array>({
    start(controller) {
      abortSignal = AbortSignal.any([...signals, controller.signal]);
    },
    async write(chunk) {
      await command.writeStdin(chunk, { abortSignal });
    },
    async close() {
      await command.closeStdin({ abortSignal });
    },
    async abort() {
      const stopped = AbortSignal.any([...signals]);
      if (!stopped.aborted) await command.closeStdin({ abortSignal: stopped });
    },
  });
}

export interface StreamingCommandHandle {
  kill?(): PromiseLike<void>;
}

export interface StreamingCommandFinished extends StreamingCommandHandle {
  readonly exitCode: number;
}

export async function adaptStreamingCommandToSandboxProcess(input: {
  readonly abortSignal?: AbortSignal;
  readonly onRelease?: () => void;
  readonly start: (streams: {
    readonly onStart: (command: StreamingCommandHandle) => void;
    readonly stderr: Writable;
    readonly stdout: Writable;
  }) => PromiseLike<StreamingCommandFinished>;
}): Promise<SandboxProcess> {
  const { abortSignal: signal, onRelease } = input;
  const stdout = createOutputChannel();
  const stderr = createOutputChannel();
  const started = Promise.withResolvers<StreamingCommandHandle>();

  let done = false;
  let released = false;
  let killPromise: Promise<void> | undefined;
  let startedCommand: StreamingCommandHandle | undefined;

  const releaseOnce = () => {
    if (released) return;
    released = true;
    onRelease?.();
  };

  const kill = () =>
    (killPromise ??= Promise.resolve().then(async () => {
      await startedCommand?.kill?.();
      releaseOnce();
    }));

  const killOnAbort = () => {
    if (!done && startedCommand !== undefined) {
      void kill().catch(() => undefined);
    }
  };
  const disarmKill = () => signal?.removeEventListener("abort", killOnAbort);
  signal?.addEventListener("abort", killOnAbort, { once: true });

  const runPromise = Promise.resolve().then(() =>
    input.start({
      onStart(command) {
        startedCommand = command;
        started.resolve(command);
        if (signal?.aborted) killOnAbort();
      },
      stderr: createChannelWritable(stderr),
      stdout: createChannelWritable(stdout),
    }),
  );

  const settled = runPromise.then(
    (finished) => {
      startedCommand ??= finished;
      started.resolve(finished);
      done = true;
      disarmKill();
      releaseOnce();
      stdout.close();
      stderr.close();
      return { exitCode: finished.exitCode };
    },
    (error: unknown) => {
      if (signal?.aborted && startedCommand !== undefined) {
        void kill().catch(() => undefined);
      }
      started.reject(error);
      done = true;
      disarmKill();
      releaseOnce();
      const cause = signal?.aborted ? signal.reason : error;
      stdout.error(cause);
      stderr.error(cause);
      throw cause;
    },
  );
  settled.catch(() => undefined);

  await started.promise;

  return {
    stderr: stderr.stream,
    stdout: stdout.stream,
    wait: () => settled,
    kill,
  };
}

export function adaptMultiplexedCommandToSandboxProcess<
  Log extends { readonly data: string },
>(input: {
  readonly abortSignal?: AbortSignal;
  readonly command: MultiplexedCommand<Log>;
  readonly getOutput: (log: Log) => OutputName;
  readonly stdin?: StdinCommand;
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
      const cause = signal?.aborted ? signal.reason : error;
      stdout.error(cause);
      stderr.error(cause);
      throw cause;
    }
  })();

  let waitPromise: Promise<{ exitCode: number }> | undefined;
  let killPromise: Promise<void> | undefined;
  const stopped = new AbortController();
  const kill = () => {
    stopped.abort();
    return (killPromise ??= Promise.resolve().then(() => command.kill()));
  };

  const killOnAbort = () => void kill().catch(() => undefined);
  const disarmKill = () => signal?.removeEventListener("abort", killOnAbort);
  if (signal?.aborted) killOnAbort();
  signal?.addEventListener("abort", killOnAbort, { once: true });
  void logsDone.then(disarmKill, () => undefined);

  return {
    stdin:
      input.stdin === undefined
        ? undefined
        : createStdinStream(
            input.stdin,
            signal === undefined ? [stopped.signal] : [stopped.signal, signal],
          ),
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
