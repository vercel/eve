import { forgetSessionLive } from "#definitions/state.js";
import { NonRetryableError } from "#shared/run-errors.js";

const DEFAULT_MAX_RETRIES = 3;

export interface StepFaults {
  loseCompletion?(step: StepAttempt): boolean;
  failWrite?(step: StepAttempt, chunk: Uint8Array): boolean;
  retrying?(step: StepAttempt): Promise<void>;
  readonly maxRetries?: number;
}

export interface StepAttempt {
  readonly name: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

export interface StepAttempts {
  current(): number | undefined;
  enter<T>(attempt: number, step: () => Promise<T>): Promise<T>;
  run<I, T>(
    step: Omit<StepAttempt, "attempt">,
    prepare: (attempt: StepAttempt) => Promise<I>,
    enter: (input: I) => Promise<T>,
  ): Promise<T>;
  writable(step: StepAttempt, stream: WritableStream<Uint8Array>): WritableStream<Uint8Array>;
}

export function createStepAttempts(faults: StepFaults | undefined): StepAttempts {
  const maxRetries = faults?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retries = `${maxRetries} ${maxRetries === 1 ? "retry" : "retries"}`;
  let entering: number | undefined;
  const enter: StepAttempts["enter"] = (attempt, step) => {
    entering = attempt;
    try {
      return step();
    } finally {
      entering = undefined;
    }
  };
  return {
    current: () => entering,
    enter,
    async run(step, prepare, body) {
      for (let attempt = 1; ; attempt++) {
        if (attempt > maxRetries + 1)
          throw new NonRetryableError(`Step "${step.name}" exceeded max retries (${retries})`);
        const current = { ...step, attempt };
        let result: Awaited<ReturnType<typeof body>>;
        try {
          const input = await prepare(current);
          result = await enter(attempt, () => body(input));
        } catch (error) {
          if (faults === undefined || isFatal(error)) throw error;
          if (attempt > maxRetries) {
            const message = error instanceof Error ? error.message : String(error);
            throw new NonRetryableError(`Step "${step.name}" failed after ${retries}: ${message}`, {
              cause: error,
            });
          }
          forgetSessionLive(step.sessionId);
          await faults.retrying?.({ ...current, attempt: attempt + 1 });
          continue;
        }
        if (faults?.loseCompletion?.(current) !== true) return result;
        forgetSessionLive(step.sessionId);
      }
    },
    writable(step, stream) {
      const failWrite = faults?.failWrite;
      if (step.attempt === 1 && failWrite === undefined) return stream;
      return attemptWritable(stream, (chunk) => failWrite?.(step, chunk) === true);
    },
  };
}

function isFatal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "FatalError" &&
    (error as { readonly fatal?: unknown }).fatal === true
  );
}

function attemptWritable(
  stream: WritableStream<Uint8Array>,
  fails: (chunk: Uint8Array) => boolean,
): WritableStream<Uint8Array> {
  const withWriter = async (
    use: (writer: WritableStreamDefaultWriter<Uint8Array>) => Promise<void>,
  ) => {
    const writer = stream.getWriter();
    try {
      await use(writer);
    } finally {
      writer.releaseLock();
    }
  };
  return new WritableStream<Uint8Array>({
    write: async (chunk) => {
      if (fails(chunk)) throw new Error("The session stream is unavailable");
      await withWriter((writer) => writer.write(chunk));
    },
    close: () => withWriter((writer) => writer.close()),
  });
}
