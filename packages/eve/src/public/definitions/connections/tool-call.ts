import type { SessionContext } from "#public/definitions/callback-context.js";
import type { JsonValue } from "#public/types/json.js";

/** Context available while resolving an application-provided connection tool argument. */
export type ProvidedArgumentContext = SessionContext & {
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
}
