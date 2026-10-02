import type { InputRequest } from "#shared/input.js";
import { isApprovalRequest } from "#harness/input-request-class.js";

/** Label prefixing the framework-injected pending-approval notice. */
export const PENDING_APPROVALS_LABEL = "[Pending approvals]";

/** True when text is the framework-injected pending-approval notice. */
export function isPendingApprovalsSnippet(text: string): boolean {
  return text.startsWith(PENDING_APPROVALS_LABEL);
}

/**
 * Renders the durable, model-visible projection of unresolved tool approvals.
 * The harness appends it when the batch is created, so later wakeups reuse the
 * same history prefix instead of regenerating the notice.
 */
export function renderPendingApprovalsSnippet(
  requests: readonly InputRequest[],
): string | undefined {
  const approvals = requests.filter((request) => isApprovalRequest(request));
  if (approvals.length === 0) return undefined;

  return [
    PENDING_APPROVALS_LABEL,
    "The following tool calls are awaiting approval and have not executed:",
    ...approvalIdentities(approvals),
  ].join("\n");
}

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
    "Interpret the latest user message normally. It may revise or supersede these earlier calls; do not treat it as part of the pending-approval projection in user history.",
  ].join("\n");
}

function approvalIdentities(requests: readonly InputRequest[]): string[] {
  return requests.map((request) =>
    JSON.stringify({ requestId: request.requestId, toolName: request.action.toolName }),
  );
}
