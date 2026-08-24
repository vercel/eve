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
    ...approvals.map((request) =>
      JSON.stringify({ requestId: request.requestId, toolName: request.action.toolName }),
    ),
  ].join("\n");
}
