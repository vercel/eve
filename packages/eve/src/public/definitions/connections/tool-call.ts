import type { JsonValue } from "#public/types/json.js";
import type { ConnectionCallbackContext } from "#shared/connection-types.js";

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

/** Context available while choosing what the model reads for a failed connection tool call. */
export type ConnectionToolErrorContext = ProvidedArgumentContext;

/**
 * What the model reads when a call to the connection fails: return the text, or `undefined` for
 * eve's default (the error's name and message).
 */
export type ConnectionToolErrorHandler = (
  error: unknown,
  ctx: ConnectionToolErrorContext,
) => string | undefined | Promise<string | undefined>;

/** Per-call behavior shared by tools exposed through a connection. */
export interface ConnectionToolCallDefinition {
  /** Application-owned arguments hidden from the model and added at execution time. */
  readonly providedArguments?: ProvidedArgumentsDefinition;
  /**
   * Chooses what the model reads when a call to the connection fails: a transport or protocol
   * error, or a timeout. A tool result the server marks as an error is not a failure here; the
   * model reads it as the server wrote it. Logs and telemetry keep the original error.
   *
   * Return `undefined` to keep eve's default. If the handler throws, eve logs it and keeps the
   * default.
   */
  readonly onError?: ConnectionToolErrorHandler;
}
