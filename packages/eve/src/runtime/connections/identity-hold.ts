import {
  type AlsContext,
  contextScopeValue,
  contextStorage,
  withContextScopeValue,
} from "#context/container.js";
import { SteeredByKey } from "#context/keys.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";

const MODEL_CALL = Symbol.for("eve.modelCall");

export function withModelCall<T>(fn: () => T): T {
  return withContextScopeValue(MODEL_CALL, true, fn);
}

export function steeredModelCall(ctx: AlsContext | undefined = contextStorage.getStore()): boolean {
  return contextScopeValue(MODEL_CALL) === true && (ctx?.get(SteeredByKey) ?? []).length > 0;
}

export function turnSteeredMessage(subject: string): string {
  return (
    `Another person's message joined this turn after its caller last spoke, so ${subject} ` +
    `can't use the caller's identity. Ask the caller to confirm in this conversation, then try again.`
  );
}

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
