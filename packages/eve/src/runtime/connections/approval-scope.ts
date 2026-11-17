import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";
import type { ConnectionCallbackContext } from "#shared/connection-types.js";
import type { ApprovedCall } from "#tools/definition.js";

const APPROVAL = Symbol("eve.connectionApproval");

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

export function buildConnectionCallbackContext(): ConnectionCallbackContext {
  const approval = contextScopeValue<ApprovedCall>(APPROVAL);
  return { ...buildCallbackContext(), ...(approval !== undefined && { approval }) };
}
