import type { SessionContext } from "#public/definitions/callback-context.js";
import type { JsonValue } from "#public/types/json.js";
import type { ToolModelOutput } from "#tools/model-output.js";

/** Context available while resolving an application-provided connection tool argument. */
export type ProvidedArgumentContext = SessionContext & {
  /** Replay-stable id of the current connection tool call. */
  readonly callId: string;
  /** Bare tool or operation name published by the remote connection. */
  readonly toolName: string;
};

/** A static or per-call value for one application-provided connection tool argument. */
export type ProvidedArgumentValue =
  | JsonValue
  | Promise<JsonValue>
  | ((ctx: ProvidedArgumentContext) => JsonValue | Promise<JsonValue>);

/**
 * Connection tool argument values supplied by the application instead of the model.
 *
 * Configured keys are removed from remote input schemas before the schemas are
 * exposed to the model, then resolved and added to every outgoing tool call.
 */
export type ProvidedArgumentsDefinition = Readonly<Record<string, ProvidedArgumentValue>>;

/**
 * Projects one connection operation's execution result into the value shown
 * to the model, matching an authored tool's `toModelOutput` contract.
 *
 * The remote result shape belongs to the connection rather than eve, so
 * `output` is unchecked. Annotate it with the type the operation returns.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConnectionToolModelOutput = (output: any) => ToolModelOutput | Promise<ToolModelOutput>;

/** Model-facing result projections keyed by bare remote tool or operation name. */
export type ConnectionToModelOutputDefinition = Readonly<Record<string, ConnectionToolModelOutput>>;

/** Per-call behavior shared by tools exposed through a connection. */
export interface ConnectionToolCallDefinition {
  /** Application-owned arguments hidden from the model and added at execution time. */
  readonly providedArguments?: ProvidedArgumentsDefinition;
  /**
   * Per-operation projections controlling what the model sees as the result.
   * Operations without an entry keep the default serialization. The full
   * connection result remains available through `action.result`.
   */
  readonly toModelOutput?: ConnectionToModelOutputDefinition;
}
