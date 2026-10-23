import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import { approvalDecision, type ApprovalDecision } from "#approval/status.js";

export interface ApprovalGrant {
  readonly toolName: string;
  readonly interactionId: string;
}

/** An accepted answer establishes a session grant for this tool. */
export interface ApprovalGrantRequest {
  readonly toolName: string;
}

// Bundles may load the once() helper and the harness from separate copies of this module.
// The global key lets a copy find the evaluation; `once` returns the creating copy's markers.
interface Evaluation {
  readonly once: () => OnceStatus;
  readonly recheck?: boolean;
}

// Enumerable symbols survive policy context spreads without entering JSON or the public type.
const evaluationKey = Symbol.for("eve.approval-evaluation");
type EvaluatedContext = ApprovalContext & { readonly [evaluationKey]?: Evaluation };

// Credit goes to once() only when a policy returns these exact objects, not an equal status.
const onceGranted = Object.freeze({ type: "not-applicable" as const });
const onceRequired = Object.freeze({ type: "user-approval" as const });
type OnceStatus = typeof onceGranted | typeof onceRequired;

function withEvaluation<T extends ApprovalContext>(context: T, evaluation: Evaluation): T {
  return { ...context, [evaluationKey]: Object.freeze(evaluation) };
}

export function withApprovalGrants<T extends ApprovalContext>(
  context: T,
  grants: readonly ApprovalGrant[],
): T {
  const status = grants.some((grant) => grant.toolName === context.toolName)
    ? onceGranted
    : onceRequired;
  return withEvaluation(context, {
    once: () => status,
    recheck: approvalEvaluation(context)?.recheck,
  });
}

export function evaluateOnce(context: ApprovalContext): OnceStatus {
  return approvalEvaluation(context)?.once() ?? onceRequired;
}

export async function evaluateApproval(
  policy: ApprovalPolicy,
  context: ApprovalContext,
  grants: readonly ApprovalGrant[],
  recheck: boolean,
): Promise<ApprovalDecision> {
  const { toolName } = context;
  const evaluation = withApprovalGrants(context, grants);
  const status = await policy(recheck ? markApprovalRecheck(evaluation) : evaluation);
  const decision = approvalDecision(status);
  if (recheck && decision.awaitsPerson === true) return { denied: false };
  if (status === onceRequired) return { ...decision, grantOnAcceptance: { toolName } };
  const grant =
    status === onceGranted ? grants.find((entry) => entry.toolName === toolName) : undefined;
  return grant === undefined
    ? decision
    : { ...decision, clearedBy: { grant: { interactionId: grant.interactionId } } };
}

export function rememberAcceptedApproval(
  grants: readonly ApprovalGrant[],
  request: {
    readonly interactionId: string;
    readonly grantOnAcceptance?: ApprovalGrantRequest;
  },
): readonly ApprovalGrant[] {
  const grant = request.grantOnAcceptance;
  return grant === undefined
    ? grants
    : [
        ...grants.filter((entry) => entry.toolName !== grant.toolName),
        { ...grant, interactionId: request.interactionId },
      ];
}

/** An outstanding independent question must not be bypassed by another answer's grant. */
export function availableApprovalGrants(
  grants: readonly ApprovalGrant[],
  pending: readonly { readonly grantOnAcceptance?: ApprovalGrantRequest }[],
): readonly ApprovalGrant[] {
  return grants.filter(
    (grant) => !pending.some((request) => request.grantOnAcceptance?.toolName === grant.toolName),
  );
}

function approvalEvaluation(context: ApprovalContext): Evaluation | undefined {
  return (context as EvaluatedContext)[evaluationKey];
}

function markApprovalRecheck<T extends ApprovalContext>(context: T): T {
  return withEvaluation(context, {
    once: approvalEvaluation(context)?.once ?? (() => onceRequired),
    recheck: true,
  });
}

export function inheritApprovalContext<T extends ApprovalContext>(
  source: ApprovalContext,
  context: T,
): T {
  const evaluation = approvalEvaluation(source);
  if (evaluation === undefined || approvalEvaluation(context) === evaluation) return context;
  return { ...context, [evaluationKey]: evaluation };
}

/** Whether `context` is the re-check of an approved call just before it runs. */
export function isApprovalRecheck(context: ApprovalContext): boolean {
  return approvalEvaluation(context)?.recheck === true;
}
