import type { SessionAuthContext } from "#channel/types.js";
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
 * The people steering the turn when a call the model made asks for its caller's identity, or
 * `undefined` when the identity is free to use: the caller spoke last, or eve is doing its own
 * work for the caller, such as listing a connection's tools.
 */
export function steeringModelCall(
  ctx: AlsContext | undefined = contextStorage.getStore(),
): readonly SessionAuthContext[] | undefined {
  if (contextScopeValue(MODEL_CALL) !== true) return undefined;
  const steeredBy = ctx?.get(SteeredByKey) ?? [];
  return steeredBy.length === 0 ? undefined : steeredBy;
}

/** Tells the model why the call was refused and what unblocks it. */
export function turnSteeredMessage(
  steeredBy: readonly SessionAuthContext[],
  subject: string,
): string {
  const people = steeredBy.map((person) => person.principalId).join(", ");
  return (
    `A message from ${people} joined this turn after its caller last spoke, so ${subject} ` +
    `can't use the caller's identity. Ask the caller to confirm in this conversation, then try again.`
  );
}

/** Refuses the caller's identity to a call the model made while other people steer the turn. */
export function holdCallerIdentity(connectionName: string, ctx?: AlsContext): void {
  const steeredBy = steeringModelCall(ctx);
  if (steeredBy === undefined) return;
  throw new ConnectionAuthorizationFailedError(connectionName, {
    message: turnSteeredMessage(steeredBy, `connection "${connectionName}"`),
    reason: "turn_steered",
    retryable: false,
  });
}
