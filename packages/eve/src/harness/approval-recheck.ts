import type { ApprovalContext } from "#approval/definition.js";

export interface ApprovalGrant {
  readonly toolName: string;
  readonly key?: string;
  readonly interactionId: string;
}

export interface OnceApproval {
  readonly key?: string;
  readonly grantable: boolean;
}

interface Evaluation {
  readonly grants: readonly ApprovalGrant[];
  recheck?: boolean;
  once?: OnceApproval;
  grant?: ApprovalGrant;
}

// Enumerable symbols survive policy context spreads without entering JSON or the public type.
const evaluationKey = Symbol.for("eve.approval-evaluation");
type EvaluatedContext = ApprovalContext & { readonly [evaluationKey]?: Evaluation };

export function withApprovalGrants<T extends ApprovalContext>(
  context: T,
  grants: readonly ApprovalGrant[],
): T {
  return Object.assign(context, {
    [evaluationKey]: { grants, recheck: approvalEvaluation(context)?.recheck },
  });
}

export function evaluateOnce(context: ApprovalContext, once: OnceApproval): boolean {
  let evaluation = approvalEvaluation(context);
  if (evaluation === undefined) {
    evaluation = { grants: [] };
    Object.assign(context, { [evaluationKey]: evaluation });
  }
  evaluation.once = once;
  evaluation.grant = once.grantable
    ? evaluation.grants.find(
        (grant) => grant.toolName === context.toolName && grant.key === once.key,
      )
    : undefined;
  return evaluation.grant !== undefined;
}

export function approvalEvaluation(context: ApprovalContext): Evaluation | undefined {
  return (context as EvaluatedContext)[evaluationKey];
}

export function markApprovalRecheck<T extends ApprovalContext>(context: T): T {
  const evaluation = approvalEvaluation(context) ?? { grants: [] };
  evaluation.recheck = true;
  if (approvalEvaluation(context) === undefined)
    Object.assign(context, { [evaluationKey]: evaluation });
  return context;
}

export function inheritApprovalContext<T extends ApprovalContext>(
  source: ApprovalContext,
  context: T,
): T {
  const evaluation = approvalEvaluation(source);
  if (evaluation !== undefined && approvalEvaluation(context) !== evaluation) {
    Object.assign(context, { [evaluationKey]: evaluation });
  }
  return context;
}

/** Whether `context` is the re-check of an approved call just before it runs. */
export function isApprovalRecheck(context: ApprovalContext): boolean {
  return approvalEvaluation(context)?.recheck === true;
}
