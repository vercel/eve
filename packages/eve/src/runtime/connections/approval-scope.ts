import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import type { ConnectionCallbackContext } from "#shared/connection-types.js";

// Branch-local rather than a context key: approved calls in one step run in parallel and share
// the step's context, so each call's requests must read only their own approver.
const APPROVAL_RESPONDER = Symbol("eve.connectionApprovalResponder");

/** Runs one connection tool call so its `headers` and provided arguments see who approved it. */
export function withConnectionApproval<T>(
  responder: SessionAuthContext | undefined,
  fn: () => T,
): T {
  return responder === undefined ? fn() : withContextScopeValue(APPROVAL_RESPONDER, responder, fn);
}

/** The session context a connection's `headers` and provided-argument callbacks receive. */
export function buildConnectionCallbackContext(): ConnectionCallbackContext {
  const responder = contextScopeValue<SessionAuthContext>(APPROVAL_RESPONDER);
  return {
    ...buildCallbackContext(),
    ...(responder !== undefined && { approval: { responder } }),
  };
}
