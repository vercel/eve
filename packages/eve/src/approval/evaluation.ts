import type { ApprovalContext, ApprovalPolicy, ApprovalStatus } from "#approval/definition.js";
import { approvalDecision, type ApprovalDecision } from "#approval/status.js";
import type { JsonValue } from "#shared/json.js";

export interface RememberedApproval {
  readonly outcome: "accepted" | "declined";
  readonly interactionId: string;
  readonly state?: JsonValue;
}

export interface RememberRequest {
  readonly key: string;
  readonly state?: JsonValue;
}

export interface ApprovalMemory {
  readonly remembered: Readonly<Record<string, RememberedApproval>>;
  readonly pending: readonly string[];
}

const NO_MEMORY: ApprovalMemory = { pending: [], remembered: {} };

export interface ApprovalEvaluation {
  readonly recheck: boolean;
  readonly read: (key: string) => {
    readonly entry?: RememberedApproval;
    readonly pending: boolean;
  };
  readonly ask: (remember: RememberRequest) => ApprovalStatus;
}

const evaluationKey = Symbol.for("eve.approval-evaluation");
type EvaluatedContext = ApprovalContext & { readonly [evaluationKey]?: ApprovalEvaluation };

export function approvalEvaluation(context: ApprovalContext): ApprovalEvaluation | undefined {
  return (context as EvaluatedContext)[evaluationKey];
}

export async function evaluateApproval(
  policy: ApprovalPolicy,
  context: ApprovalContext,
  input: { readonly memory?: ApprovalMemory; readonly recheck?: boolean } = {},
): Promise<ApprovalDecision> {
  const { memory = NO_MEMORY, recheck = false } = input;
  const asked = new WeakMap<object, RememberRequest>();
  const scoped = (key: string) => JSON.stringify([context.toolName, key]);
  const evaluation: ApprovalEvaluation = Object.freeze({
    ask: (remember: RememberRequest) => {
      const status = Object.freeze({ type: "user-approval" as const });
      asked.set(status, { ...remember, key: scoped(remember.key) });
      return status;
    },
    read: (key: string) => ({
      entry: memory.remembered[scoped(key)],
      pending: memory.pending.includes(scoped(key)),
    }),
    recheck,
  });
  const evaluated: EvaluatedContext = { ...context, [evaluationKey]: evaluation };
  const status = await policy(evaluated);
  const decision = approvalDecision(status);
  if (decision.awaitsPerson !== true) return decision;
  if (recheck) return { denied: false };
  const remember = typeof status === "object" && status !== null ? asked.get(status) : undefined;
  return remember === undefined ? decision : { ...decision, remember };
}

export function rememberDecision(
  remembered: Readonly<Record<string, RememberedApproval>>,
  request: { readonly interactionId: string; readonly remember?: RememberRequest },
  outcome: RememberedApproval["outcome"],
): Readonly<Record<string, RememberedApproval>> {
  const { remember } = request;
  if (remember === undefined) return remembered;
  return {
    ...remembered,
    [remember.key]: {
      interactionId: request.interactionId,
      outcome,
      ...(remember.state !== undefined && { state: remember.state }),
    },
  };
}

export function inheritApprovalContext<T extends ApprovalContext>(
  source: ApprovalContext,
  context: T,
): T {
  const evaluation = approvalEvaluation(source);
  if (evaluation === undefined || approvalEvaluation(context) === evaluation) return context;
  return { ...context, [evaluationKey]: evaluation };
}

export function scopeApprovalEvaluation<T extends ApprovalContext>(context: T, scope: string): T {
  const evaluation = approvalEvaluation(context);
  if (evaluation === undefined) return context;
  const scoped = (key: string) => JSON.stringify([scope, key]);
  const narrowed: ApprovalEvaluation = Object.freeze({
    ask: (remember: RememberRequest) => evaluation.ask({ ...remember, key: scoped(remember.key) }),
    read: (key: string) => evaluation.read(scoped(key)),
    recheck: evaluation.recheck,
  });
  return { ...context, [evaluationKey]: narrowed };
}

export function isApprovalRecheck(context: ApprovalContext): boolean {
  return approvalEvaluation(context)?.recheck === true;
}
