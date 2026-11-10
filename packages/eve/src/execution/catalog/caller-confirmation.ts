import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalContext,
  type ApprovalPolicy,
} from "#approval/definition.js";
import { approvalEvaluation } from "#approval/evaluation.js";
import { approvalDecision } from "#approval/status.js";
import { callerSpokeLast } from "#runtime/connections/caller-confirmation.js";

/**
 * Rule 3's default for an entry that acts as the caller: while the caller isn't the last to have
 * spoken, each call asks them first, and only they can approve. It applies after the entry's and
 * the agent's approval, not in their strictest-wins join, so a mismatch helper's clearance skips
 * it and a denial stands. Any other clearance, such as `auto()`'s, still asks: only the caller's
 * approval releases their identity.
 */
export function withCallerConfirmationDefault(
  approval: Approval | undefined,
  actsAsCaller: (context: ApprovalContext) => boolean | Promise<boolean>,
): Approval {
  const policy = approval === undefined ? undefined : resolveApprovalPolicy(approval);
  const request: ApprovalPolicy = async (context) => {
    const status = policy === undefined ? undefined : await policy(context);
    if (callerSpokeLast(context.session.auth)) return status;
    const evaluation = approvalEvaluation(context);
    if (evaluation?.callerConfirmed() === true) return status;
    const decision = approvalDecision(status);
    if (decision.denied || !(await actsAsCaller(context))) return status;
    // Another policy's ask stays its own, with what it remembers, but only the caller approves it.
    if (evaluation === undefined) return "user-approval";
    return evaluation.requireCaller(decision.awaitsPerson === true ? status : "user-approval");
  };
  if (approval === undefined || typeof approval === "function") return request;
  return { ...approval, request };
}
