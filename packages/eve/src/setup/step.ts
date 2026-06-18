/** Where a box streams progress and command output during {@link SetupBox.perform}. */
export interface OutputSink {
  write(line: string): void;
}

/**
 * Thrown by the interactive prompter when the user cancels (Ctrl-C, or the
 * two-stage Escape quit). The runner converts it into a cancelled run, so a
 * box's gather face does not need its own try/catch to honor a cancel.
 */
export class WizardCancelledError extends Error {
  constructor() {
    super("Wizard cancelled.");
    this.name = "WizardCancelledError";
  }
}

/**
 * Thrown when the user asks to step *back* one prompt (dev-TUI Esc) inside a
 * reversible sequence. A subclass of {@link WizardCancelledError} on purpose:
 * a reversible runner catches `StepBackError` specifically to re-ask the
 * previous step, but anywhere it is not caught — backing past the first step,
 * or Esc in a non-reversible prompt — the existing `WizardCancelledError`
 * handling folds it to a clean cancel (back to chat). The CLI prompter never
 * throws this; its quit-guard throws the base error, so shared flows stay
 * linear under `eve link` / `eve init`.
 */
export class StepBackError extends WizardCancelledError {
  constructor() {
    super();
    this.name = "StepBackError";
  }
}

/**
 * A unit of work reusable by programmatic setup and channel-management flows.
 * Every box has ONE gather for every mode: it asks its questions through an
 * injected `Asker`, whose composed stack (interactive base, headless base,
 * answer/policy decorators) decides how each question resolves; a user cancel
 * propagates as {@link WizardCancelledError} for the runner to fold. `perform`
 * owns the side effects once and `apply` records the result once, so
 * interactive and headless execution cannot drift.
 *
 * `Input` is what a user/preset chooses; `Payload` is what `perform` actually
 * did (which may differ from what was requested, e.g. a skipped channel).
 */
export interface SetupBox<State, Input, Payload> {
  readonly id: string;

  /** Skip the box when its work does not apply to the current state. */
  shouldRun?(state: Readonly<State>): boolean;

  /** One-line status for a menu-driven runner (unused by the linear wizard). */
  summary?(state: Readonly<State>): string;

  /** Mode-agnostic face: resolve the input, asking through the box's asker. */
  gather(ctx: {
    state: Readonly<State>;
    initial?: Input;
    /** Parent flow cancellation, when this box runs under an interruptible UI. */
    signal?: AbortSignal;
  }): Promise<Input>;

  /** The only side-effecting step. Must be idempotent: detect current files,
   *  link state, and connectors before mutating, so a rerun converges. */
  perform(ctx: {
    state: Readonly<State>;
    input: Input;
    sink: OutputSink;
    /** Parent flow cancellation, when this box runs under an interruptible UI. */
    signal?: AbortSignal;
  }): Promise<Payload>;

  /** The only in-memory state transition. Pure: no I/O. */
  apply(state: State, payload: Payload): State;
}
