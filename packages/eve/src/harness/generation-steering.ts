import type { SessionEvent } from "#protocol/session-event.js";

class GenerationSteeredError extends Error {
  constructor() {
    super("Model generation superseded by steering.");
    this.name = "GenerationSteeredError";
  }
}

/** Interrupts generation without cancelling the turn or replaying local effects. */
export class GenerationSteering {
  private readonly controller = new AbortController();
  private active = false;
  private effectsStarted = false;
  private readonly steeringSignal: AbortSignal | undefined;
  readonly signal: AbortSignal;
  outputStarted: boolean;

  constructor(input: {
    abortSignal?: AbortSignal;
    steeringSignal?: AbortSignal;
    outputStarted?: boolean;
  }) {
    this.steeringSignal = input.steeringSignal;
    this.outputStarted = input.outputStarted === true;
    this.signal =
      input.steeringSignal === undefined && input.abortSignal !== undefined
        ? input.abortSignal
        : input.abortSignal === undefined
          ? this.controller.signal
          : AbortSignal.any([input.abortSignal, this.controller.signal]);
    this.steeringSignal?.addEventListener("abort", this.onSteering);
  }

  get interrupted(): boolean {
    return this.controller.signal.aborted;
  }

  begin(): void {
    this.active = true;
    this.onSteering();
    this.check();
  }

  /** Steering cut the generation; what the step still publishes settles it, so nothing stops it. */
  end(): void {
    this.active = false;
  }

  protectToolExecution(): void {
    this.check();
    this.effectsStarted = true;
  }

  beforeEvent(event: SessionEvent): void {
    if (!this.active) return;
    this.check();
    // Published requests and terminal events must finish committing, even
    // when the model produced no assistant text.
    if (
      event.type === "interaction.opened" ||
      (event.type === "model.settled" && event.data.outcome === "failed") ||
      event.type === "turn.settled"
    )
      this.effectsStarted = true;
    if (
      (event.type === "content.delta" &&
        event.data.kind === "text" &&
        event.data.delta.length > 0) ||
      (event.type === "content.completed" &&
        (event.data.kind === "result" ||
          (event.data.kind === "text" &&
            typeof event.data.value === "string" &&
            event.data.value.length > 0)))
    )
      this.outputStarted = true;
  }

  check(): void {
    if (this.interrupted) throw this.controller.signal.reason;
  }

  dispose(): void {
    this.steeringSignal?.removeEventListener("abort", this.onSteering);
  }

  private readonly onSteering = (): void => {
    if (
      this.active &&
      !this.effectsStarted &&
      !this.outputStarted &&
      this.steeringSignal?.aborted
    ) {
      this.controller.abort(new GenerationSteeredError());
    }
  };
}
