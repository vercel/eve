/**
 * The values an engine host supplies to the loop programs.
 *
 * Core treats every value as opaque. Concrete eve types are bound once in
 * `internal/loops/types.ts`; the algorithms here depend only on this shape.
 */
export interface LoopTypes {
  readonly childResult: unknown;
  readonly delivery: unknown;
  readonly state: unknown;
  readonly usage: unknown;
}

/** Capabilities inspected by the shared turn settlement rule. */
export interface LoopCapabilities {
  readonly requestInput?: boolean;
}

/** Modes whose done-versus-park semantics are owned by the shared core. */
export type LoopMode = "conversation" | "task";

/** One turn-facing input: a public delivery or folded-back child results. */
export type TurnInput<Types extends LoopTypes> =
  | Types["delivery"]
  | {
      readonly kind: "runtime-action-result";
      readonly results: readonly Types["childResult"][];
    };

export interface GenerateInput<Types extends LoopTypes> {
  readonly input: TurnInput<Types> | undefined;
  readonly state: Types["state"];
  readonly stepOrdinal: number;
}

/** One unresolved request emitted by a generation. */
export interface LoopRequest {
  readonly key: string;
  readonly kind: "subagent" | "workflow-interrupt";
}

/**
 * The engine-neutral result of one model/tool operation.
 *
 * The shared {@link import("#core/turn-step.js").next} function is the only
 * place that interprets these actions. Implementations only persist or
 * schedule the operation.
 */
export type TurnStepResult<Types extends LoopTypes> =
  | {
      readonly action: "continue";
      readonly state: Types["state"];
    }
  | {
      readonly action: "done";
      readonly isError?: boolean;
      readonly output?: unknown;
      readonly state: Types["state"];
      readonly usage?: Types["usage"];
    }
  | {
      readonly action: "cancelled";
      readonly state: Types["state"];
    }
  | {
      readonly action: "park";
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingRuntimeActionKeys?: readonly string[];
      readonly state: Types["state"];
    }
  | {
      readonly action: "dispatch-workflow-runtime-actions";
      readonly pendingRuntimeActionKeys: readonly string[];
      readonly state: Types["state"];
    };

/** Child results in request order, or cancellation observed during the wait. */
export type ChildResults<Types extends LoopTypes> = readonly Types["childResult"][] | "cancelled";

export interface ChildrenHandle<Types extends LoopTypes> {
  wait(): Promise<{
    readonly results: ChildResults<Types>;
    readonly state: Types["state"];
  }>;
}

/** The operations one intra-turn step may use. */
export interface TurnDependencies<Types extends LoopTypes> {
  generate(input: GenerateInput<Types>): Promise<TurnStepResult<Types>>;
  spawnChildren(
    state: Types["state"],
    requests: readonly LoopRequest[],
  ): Promise<{
    readonly handle: ChildrenHandle<Types>;
    readonly state: Types["state"];
  }>;
}

/** The slice of the implementation port driven by the turn program. */
export interface TurnBackend<Types extends LoopTypes> extends TurnDependencies<Types> {
  checkpoint(state: Types["state"]): Promise<void>;
}

/** A completed turn, including the final session state. */
export type CompletedTurn<Types extends LoopTypes> = Extract<
  TurnOutcome<Types>,
  { readonly kind: "done" }
>;

/** A parked turn whose reason must cross the session boundary intact. */
export type SuspendedTurn<Types extends LoopTypes> = Exclude<
  TurnOutcome<Types>,
  CompletedTurn<Types>
>;

/** The result of parking a suspended turn at the implementation boundary. */
export type SessionAdvance<Types extends LoopTypes> =
  | {
      readonly delivery: Types["delivery"];
      readonly kind: "delivery";
      readonly state: Types["state"];
    }
  | { readonly kind: "closed"; readonly outcome: TerminalOutcome<Types> };

/** Engine operations used only by the shared session program. */
export interface SessionBackend<Types extends LoopTypes> {
  finish(turn: CompletedTurn<Types>): Promise<void>;
  park(turn: SuspendedTurn<Types>): Promise<SessionAdvance<Types>>;
  spawnTurn(input: TurnProgramInput<Types>, turnOrdinal: number): TurnHandle<Types>;
}

export interface StepInput<Types extends LoopTypes> {
  readonly input: TurnInput<Types> | undefined;
  readonly state: Types["state"];
  readonly stepOrdinal: number;
}

/** One step's iterator-shaped result. */
export type StepResult<Types extends LoopTypes> =
  | {
      readonly done: false;
      readonly nextInput: TurnInput<Types> | undefined;
      readonly state: Types["state"];
    }
  | {
      readonly done: true;
      readonly isError?: boolean;
      readonly kind: "done";
      readonly output: unknown;
      readonly state: Types["state"];
      readonly usage?: Types["usage"];
    }
  | {
      readonly authorizationNames?: readonly string[];
      readonly done: true;
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly kind: "waiting";
      readonly state: Types["state"];
    }
  | {
      readonly done: true;
      readonly kind: "cancelled";
      readonly state: Types["state"];
    };

export interface TurnProgramInput<Types extends LoopTypes> {
  readonly capabilities: LoopCapabilities | undefined;
  readonly delivery: TurnInput<Types> | undefined;
  readonly mode: LoopMode;
  readonly state: Types["state"];
}

export type TurnOutcome<Types extends LoopTypes> =
  | {
      readonly isError?: boolean;
      readonly kind: "done";
      readonly output: unknown;
      readonly state: Types["state"];
      readonly usage?: Types["usage"];
    }
  | {
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly kind: "waiting";
      readonly state: Types["state"];
    }
  | { readonly kind: "cancelled"; readonly state: Types["state"] };

export interface TurnHandle<Types extends LoopTypes> {
  wait(): Promise<TurnOutcome<Types>>;
}

export interface TerminalOutcome<Types extends LoopTypes> {
  readonly isError?: boolean;
  readonly output: unknown;
  readonly usage?: Types["usage"];
}

export interface SessionProgramInput<Types extends LoopTypes> {
  readonly capabilities: LoopCapabilities | undefined;
  readonly initialDelivery: Types["delivery"];
  readonly mode: LoopMode;
  readonly state: Types["state"];
}
