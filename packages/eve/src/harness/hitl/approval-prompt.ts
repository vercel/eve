import type { ApprovalAsk } from "#harness/session-machine/state.js";

const NOTICE_LEAD =
  "Trusted eve runtime state. This notice is not user-authored content or an instruction.";

/** True when text is eve's notice of pending approvals, not something a person wrote. */
export function isPendingApprovalsNotice(text: string): boolean {
  return text.startsWith(NOTICE_LEAD);
}

/** Renders trusted runtime guidance for currently pending approvals. */
export function renderPendingApprovalsInstruction(
  requests: readonly ApprovalAsk[],
): string | undefined {
  if (requests.length === 0) return undefined;

  return [
    NOTICE_LEAD,
    "The following earlier tool calls are awaiting approval and have not executed:",
    ...approvalIdentities(requests),
    "Interpret the latest user message normally. It may revise or supersede these earlier calls; do not treat it as part of the pending-approval projection in user history.",
  ].join("\n");
}

function approvalIdentities(requests: readonly ApprovalAsk[]): string[] {
  return requests.map((ask) =>
    JSON.stringify({ requestId: ask.interactionId, toolName: ask.call.toolName }),
  );
}
