import type { ApprovalResponseContext, ApprovalResponseDecision } from "#approval/definition.js";
import type { SessionAuthContext } from "#channel/types.js";

export const REQUESTER_ONLY_FEEDBACK =
  "Only the person who requested this action can respond to this approval.";

export function sameResponder(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    (left.issuer ?? "") === (right.issuer ?? "") &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

export function requesterOnlyResponse(
  context: Pick<ApprovalResponseContext, "request" | "response">,
): ApprovalResponseDecision {
  const requester = context.request.principal;
  return requester === null || sameResponder(requester, context.response.principal)
    ? { status: "allowed" }
    : { reason: REQUESTER_ONLY_FEEDBACK, status: "rejected" };
}
