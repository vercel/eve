export interface OutputSink {
  write(line: string): void;
}

export class WizardCancelledError extends Error {
  constructor() {
    super("Wizard cancelled.");
    this.name = "WizardCancelledError";
  }
}

export interface SetupBox<State, Input, Payload> {
  readonly id: string;

  shouldRun?(state: Readonly<State>): boolean;

  summary?(state: Readonly<State>): string;

  gather(ctx: { state: Readonly<State>; initial?: Input; signal?: AbortSignal }): Promise<Input>;

  perform(ctx: {
    state: Readonly<State>;
    input: Input;
    sink: OutputSink;
    signal?: AbortSignal;
  }): Promise<Payload>;

  apply(state: State, payload: Payload): State;
}
