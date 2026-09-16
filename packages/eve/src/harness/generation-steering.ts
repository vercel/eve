import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

export class GenerationSteeredError extends Error {
  constructor() {
    super("Model generation superseded by steering.");
    this.name = "GenerationSteeredError";
  }
}

/** Interrupts generation without cancelling the turn or replaying local effects. */
export class GenerationSteering {
  private readonly controller = new AbortController();
  private active = false;
  private protected = false;
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

  protectToolExecution(): void {
    this.check();
    this.protected = true;
  }

  beforeEvent(event: UnstampedMessageStreamEvent): void {
    if (!this.active) return;
    this.check();
    if (
      (event.type === "message.appended" && event.data.messageDelta.length > 0) ||
      (event.type === "message.completed" && (event.data.message?.length ?? 0) > 0) ||
      event.type === "result.completed"
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
    if (this.active && !this.protected && !this.outputStarted && this.steeringSignal?.aborted) {
      this.controller.abort(new GenerationSteeredError());
    }
  };
}
