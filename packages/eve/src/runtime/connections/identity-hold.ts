import {
  type AlsContext,
  contextScopeValue,
  contextStorage,
  withContextScopeValue,
} from "#context/container.js";
import { SteeredByKey } from "#context/keys.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";

// Branch-local rather than a context key: calls in one step run in parallel and share the
// step's context, and eve's own work for the caller runs in that context outside any call.
const MODEL_CALL = Symbol("eve.modelCall");

/** Runs one call the model made, so the caller identity hold applies to what it does. */
export function withModelCall<T>(fn: () => T): T {
  return withContextScopeValue(MODEL_CALL, true, fn);
}

/**
 * Whether a call the model made runs while other people steer the turn, so it may not use the
 * caller's identity. False when the caller spoke last, and for eve's own work for the caller,
 * such as listing a connection's tools.
 */
export function steeredModelCall(ctx: AlsContext | undefined = contextStorage.getStore()): boolean {
  return contextScopeValue(MODEL_CALL) === true && (ctx?.get(SteeredByKey) ?? []).length > 0;
}

/** Tells the model why the call was refused and what unblocks it, without naming anyone. */
export function turnSteeredMessage(subject: string): string {
  return (
    `Another person's message joined this turn after its caller last spoke, so ${subject} ` +
    `can't use the caller's identity. Ask the caller to confirm in this conversation, then try again.`
  );
}

/** Refuses the caller's identity to a call the model made while other people steer the turn. */
export function holdCallerIdentity(
  connectionName: string,
  ctx?: AlsContext,
  subject = `connection "${connectionName}"`,
): void {
  if (!steeredModelCall(ctx)) return;
  throw new ConnectionAuthorizationFailedError(connectionName, {
    message: turnSteeredMessage(subject),
    reason: "turn_steered",
    retryable: false,
  });
}
