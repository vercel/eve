import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";
import type { ConnectionCallbackContext } from "#shared/connection-types.js";
import type { ApprovedCall } from "#tools/definition.js";

// Branch-local rather than a context key: approved calls in one step run in parallel and share
// the step's context, so each call's requests must read only their own approver.
const APPROVAL = Symbol("eve.connectionApproval");

/**
 * Runs one connection tool call so its `headers` and provided arguments see who approved it.
 * One authorization context serves the whole call, so its inline providers share one scope.
 */
export function withConnectionApproval<T>(
  connectionName: string,
  responder: SessionAuthContext | undefined,
  fn: () => T,
): T {
  if (responder === undefined) return fn();
  const auth = createAuthorizationContext({ scope: connectionName });
  const approval: ApprovedCall = {
    responder: {
      ...responder,
      getToken: (provider, options) => auth.getResponderToken(responder, provider, options),
    },
  };
  return withContextScopeValue(APPROVAL, approval, fn);
}

/** The session context a connection's `headers` and provided-argument callbacks receive. */
export function buildConnectionCallbackContext(): ConnectionCallbackContext {
  const approval = contextScopeValue<ApprovedCall>(APPROVAL);
  return { ...buildCallbackContext(), ...(approval !== undefined && { approval }) };
}
