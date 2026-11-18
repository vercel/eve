import { WizardCancelledError, type OutputSink, type SetupBox } from "./step.js";

export type RunResult<State> = { kind: "done"; state: State } | { kind: "cancelled" };

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return error instanceof WizardCancelledError || signal?.aborted === true;
}

export class RetryableSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableSetupError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof RetryableSetupError;
}

export type AnySetupBox<State> = SetupBox<State, unknown, unknown>;

export interface RunnerOptions<State> {
  snapshot?: (state: State) => State;
  signal?: AbortSignal;
}

export async function runInteractive<State>(
  boxes: readonly AnySetupBox<State>[],
  initialState: State,
  sink: OutputSink,
  options?: RunnerOptions<State>,
): Promise<RunResult<State>> {
  let state = initialState;
  const view = (): State => (options?.snapshot ? options.snapshot(state) : state);
  const priorInput: Record<string, unknown> = {};

  try {
    for (const box of boxes) {
      options?.signal?.throwIfAborted();
      if (box.shouldRun?.(view()) === false) continue;

      for (;;) {
        const input = await box.gather({
          state: view(),
          initial: priorInput[box.id],
          signal: options?.signal,
        });
        options?.signal?.throwIfAborted();
        priorInput[box.id] = input;

        try {
          const payload = await box.perform({
            state: view(),
            input,
            sink,
            signal: options?.signal,
          });
          options?.signal?.throwIfAborted();
          state = box.apply(state, payload);
          break;
        } catch (error) {
          if (!isRetryable(error)) throw error;
          sink.write(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } catch (error) {
    if (isCancellation(error, options?.signal)) return { kind: "cancelled" };
    throw error;
  }

  return { kind: "done", state };
}

export async function runHeadless<State>(
  boxes: readonly AnySetupBox<State>[],
  initialState: State,
  sink: OutputSink,
  options?: RunnerOptions<State>,
): Promise<State> {
  let state = initialState;
  const view = (): State => (options?.snapshot ? options.snapshot(state) : state);

  for (const box of boxes) {
    options?.signal?.throwIfAborted();
    if (box.shouldRun?.(view()) === false) continue;
    const input = await box.gather({ state: view(), signal: options?.signal });
    options?.signal?.throwIfAborted();
    const payload = await box.perform({ state: view(), input, sink, signal: options?.signal });
    options?.signal?.throwIfAborted();
    state = box.apply(state, payload);
  }

  return state;
}
