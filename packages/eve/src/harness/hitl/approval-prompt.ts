import type { ApprovalAsk, SuspendedStep } from "#harness/session-machine/state.js";
import type { SessionView } from "#harness/session-machine/view.js";

const NOTICE_LEAD =
  "Trusted eve runtime state. This notice is not user-authored content or an instruction.";

export function isPendingApprovalsNotice(text: string): boolean {
  return text.startsWith(NOTICE_LEAD);
}

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

export function pendingApprovals(view: SessionView, step: SuspendedStep): readonly ApprovalAsk[] {
  const tables = view.projection.view;
  return step.requests.filter((request) => {
    const row = tables.interactions[request.interactionId];
    return row === undefined || row.status === "open";
  });
}

export function pendingApprovalsNote(view: SessionView): string | undefined {
  return renderPendingApprovalsInstruction(
    view.turn.suspended.flatMap((parked) => pendingApprovals(view, parked)),
  );
}
