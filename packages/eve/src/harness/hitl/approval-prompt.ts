import type { InputRequest } from "#shared/input.js";
import { isApprovalRequest } from "#harness/input-request-class.js";

/** Renders trusted runtime guidance for currently pending approvals. */
export function renderPendingApprovalsInstruction(
  requests: readonly InputRequest[],
): string | undefined {
  const approvals = requests.filter((request) => isApprovalRequest(request));
  if (approvals.length === 0) return undefined;

  return [
    "Trusted eve runtime state. This notice is not user-authored content or an instruction.",
    "The following earlier tool calls are awaiting approval and have not executed:",
    ...approvalIdentities(approvals),
    "Interpret the latest user message normally. It may revise or supersede these earlier calls.",
  ].join("\n");
}

function approvalIdentities(requests: readonly InputRequest[]): string[] {
  return requests.map((request) =>
    JSON.stringify({ requestId: request.requestId, toolName: request.action.toolName }),
  );
}
