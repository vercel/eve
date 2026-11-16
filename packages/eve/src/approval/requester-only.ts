import type { ApprovalResponseContext, ApprovalResponseDecision } from "#approval/definition.js";
import type { SessionAuthContext } from "#channel/types.js";

export const REQUESTER_ONLY_FEEDBACK =
  "Only the person who requested this action can respond to this approval.";

/** Whether two auth contexts name the same principal. */
export function sameResponder(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    (left.issuer ?? "") === (right.issuer ?? "") &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

/**
 * The rule an approval has without a response policy: only its requester answers it, or anyone
 * when its requester is anonymous. A tool whose response policy covers only some of its calls
 * applies this to the rest, so a policy for one call never widens who answers another.
 */
export function requesterOnlyResponse(
  context: Pick<ApprovalResponseContext, "request" | "response">,
): ApprovalResponseDecision {
  const requester = context.request.principal;
  return requester === null || sameResponder(requester, context.response.principal)
    ? { status: "allowed" }
    : { reason: REQUESTER_ONLY_FEEDBACK, status: "rejected" };
}
