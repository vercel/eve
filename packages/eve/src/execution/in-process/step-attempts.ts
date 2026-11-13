import { forgetSessionLive } from "#definitions/state.js";
import { NonRetryableError } from "#shared/run-errors.js";

// The attempts of an in-process host's steps. A step runs once, as its first attempt, unless a
// test injects faults: then a step that lost its completion or threw runs again, as the next
// attempt, the way Workflow retries a step whose process exited after it wrote and before it
// committed, or whose body threw. What an earlier attempt wrote to its stream stays.
//
// A step reads its attempt through `isRetriedStep()` as it enters, before it first awaits, as
// `enterSessionStep` does: the attempt is named only while the step enters, so code that asks
// later reads no attempt.

/** Workflow's default: a step runs again at most this many times. */
const DEFAULT_MAX_RETRIES = 3;

/** Faults a test injects into an in-process host's steps. Off unless a test passes them. */
export interface StepFaults {
  /** Whether the attempt that just returned loses its completion. */
  loseCompletion?(step: StepAttempt): boolean;
  /**
   * Whether this write of the attempt fails. Its stream is errored from then on, so every later
   * write of that attempt fails too; the next attempt writes through a stream of its own.
   */
  failWrite?(step: StepAttempt, chunk: Uint8Array): boolean;
  /**
   * Runs before a step that threw runs again, where Workflow waits out its retry delay. A test
   * may hold the retry here.
   */
  retrying?(step: StepAttempt): Promise<void>;
  /** How many times a step runs again before it fails. Workflow's default, 3, without it. */
  readonly maxRetries?: number;
}

/** One attempt of a step. */
export interface StepAttempt {
  /** The step's name, as its failure names it. */
  readonly name: string;
  readonly sessionId: string;
  /** 1 for the first attempt, more for a retry. */
  readonly attempt: number;
  /** The step's abort signal, which every attempt reads. */
  readonly signal?: AbortSignal;
}

export interface StepAttempts {
  /** The attempt of the step entering now, or `undefined` outside a step's entry. */
  current(): number | undefined;
  /** Enters attempt `attempt` of a step: `step` runs with its attempt named until it awaits. */
  enter<T>(attempt: number, step: () => Promise<T>): Promise<T>;
  /**
   * Runs a step until an attempt keeps its completion: each attempt prepares its own input, then
   * enters the step with it. Past the retry limit the step fails, with the error Workflow's
   * exhausted step reports.
   */
  run<I, T>(
    step: Omit<StepAttempt, "attempt">,
    prepare: (attempt: StepAttempt) => Promise<I>,
    enter: (input: I) => Promise<T>,
  ): Promise<T>;
  /** The stream attempt `step` writes through: one of its own, as each of a Workflow step's is. */
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
          // Without faults, a step that threw fails at once; with them it runs again, as on
          // Workflow, unless it is fatal or out of retries.
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
        // As a process that exits does, the next attempt starts without what this one held.
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

/** Whether Workflow fails a step that threw `error` without retrying it (`FatalError.is`). */
function isFatal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "FatalError" &&
    (error as { readonly fatal?: unknown }).fatal === true
  );
}

/**
 * A writable of its own onto `stream`, as each attempt of a Workflow step restores its stream:
 * a retry reads what an earlier attempt wrote once per writable (`readOrphanedLines`). A write
 * `fails` picks errors it, as a dead stream is.
 */
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
