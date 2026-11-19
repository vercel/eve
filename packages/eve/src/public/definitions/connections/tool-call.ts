import type { JsonValue } from "#public/types/json.js";
import type { ConnectionCallbackContext } from "#shared/connection-types.js";
import type { ToolModelOutput, ToolModelOutputContext } from "#tools/model-output.js";

/** Context available while resolving an application-provided connection tool argument. */
export type ProvidedArgumentContext = ConnectionCallbackContext & {
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

/** Per-call behavior shared by tools exposed through a connection. */
export interface ConnectionToolCallDefinition {
  /** Application-owned arguments hidden from the model and added at execution time. */
  readonly providedArguments?: ProvidedArgumentsDefinition;
  /**
   * Controls what the model sees as the result of a connection tool call.
   * Receives the tool's result and returns the model-facing output. Hooks and
   * channels still get the full result on `call.settled`. Use
   * `offloadContent` from `eve/tools` to keep a large result in a sandbox file.
   * Defaults to `ctx.defaultModelOutput`.
   */
  readonly toModelOutput?: (
    output: unknown,
    ctx: ToolModelOutputContext,
  ) => ToolModelOutput | Promise<ToolModelOutput>;
}
