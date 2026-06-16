import { WizardCancelledError, type OutputSink, type SetupBox } from "./step.js";

/** Outcome of an interactive run over a set of boxes. */
export type RunResult<State> = { kind: "done"; state: State } | { kind: "cancelled" };

/**
 * The prompter signals a user cancel by throwing {@link WizardCancelledError};
 * the interactive runner folds it into a cancelled run instead of an error.
 */
function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return error instanceof WizardCancelledError || signal?.aborted === true;
}

/**
 * Thrown by a box's `perform` when the failure is recoverable by re-gathering
 * and retrying the same box (e.g. a transient `vercel` command failure). Any
 * other error propagates and aborts the run.
 */
export class RetryableSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableSetupError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof RetryableSetupError;
}

/**
 * The boxes a runner composes are heterogeneous in their `Input`/`Payload`.
 * Erasing both to `unknown` keeps composition type-safe: method parameters are
 * checked bivariantly, so a fully-typed box is assignable here, while input
 * flows gather -> perform and payload flows perform -> apply within one box.
 */
export type AnySetupBox<State> = SetupBox<State, unknown, unknown>;

/** Options shared by both runners. */
export interface RunnerOptions<State> {
  /**
   * Builds the read-only view handed to `shouldRun`, the gather faces, and
   * `perform`. Pass a deep-freezing snapshot (e.g. `snapshotSetupState`) so a
   * box mutating anything but `apply`'s return value fails loudly at runtime.
   * Defaults to the raw state.
   */
  snapshot?: (state: State) => State;
  /** Cancels the active gather/perform operation and prevents later boxes from starting. */
  signal?: AbortSignal;
}

/**
 * Linear interactive runner: walk the boxes in order, prompting for each. A box
 * whose `perform` throws a {@link RetryableSetupError} is re-gathered with the
 * prior input as the default; a cancel (a {@link WizardCancelledError} thrown
 * by a prompter) ends the whole run. There is no back navigation: side effects
 * are not undone by restoring in-memory state.
 */
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
        // A box signals a cancel by letting the prompter's WizardCancelledError
        // propagate; the catch below folds it into a cancelled run.
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

/**
 * Non-interactive runner: derive each box's input from its options and apply
 * it. No retry loop and no prompts; a box that cannot proceed without a human
 * is expected to throw from its gather (a unified box's headless-based asker
 * refuses required questions with `InteractionRequired`) or from `perform`.
 */
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
