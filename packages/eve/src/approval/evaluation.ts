import type { ApprovalContext, ApprovalPolicy, ApprovalStatus } from "#approval/definition.js";
import { approvalDecision, type ApprovalDecision } from "#approval/status.js";
import type { JsonValue } from "#shared/json.js";

/** A person's decision on a request that asked to be remembered, kept under the request's key. */
export interface RememberedApproval {
  readonly outcome: "accepted" | "declined";
  /** The interaction whose settlement recorded the decision. */
  readonly interactionId: string;
  readonly state?: JsonValue;
}

/** Where a request's settlement is remembered, with the state the policy attached. */
export interface RememberRequest {
  readonly key: string;
  readonly state?: JsonValue;
}

/** What policies can read: remembered decisions, and the keys open requests will record under. */
export interface ApprovalMemory {
  readonly remembered: Readonly<Record<string, RememberedApproval>>;
  readonly pending: readonly string[];
}

const NO_MEMORY: ApprovalMemory = { pending: [], remembered: {} };

/**
 * The harness's evaluation of one call's approval policy, private to eve's own policies. Keys are
 * scoped to the tool the harness resolved: a policy can't read or record another tool's decisions,
 * whatever key it names or however it renames its context.
 */
export interface ApprovalEvaluation {
  readonly recheck: boolean;
  readonly read: (key: string) => {
    readonly entry?: RememberedApproval;
    readonly pending: boolean;
  };
  /** Asks a person; their decision is remembered under `remember.key` when it settles. */
  readonly ask: (remember: RememberRequest) => ApprovalStatus;
}

// Bundles may load eve's policies and the harness from separate copies of this module. The global
// key lets any copy find the evaluation; an enumerable symbol survives context spreads without
// entering JSON or the public type.
const evaluationKey = Symbol.for("eve.approval-evaluation");
type EvaluatedContext = ApprovalContext & { readonly [evaluationKey]?: ApprovalEvaluation };

export function approvalEvaluation(context: ApprovalContext): ApprovalEvaluation | undefined {
  return (context as EvaluatedContext)[evaluationKey];
}

/** Runs `policy` for one call. A person who already approved the call isn't asked again. */
export async function evaluateApproval(
  policy: ApprovalPolicy,
  context: ApprovalContext,
  input: { readonly memory?: ApprovalMemory; readonly recheck?: boolean } = {},
): Promise<ApprovalDecision> {
  const { memory = NO_MEMORY, recheck = false } = input;
  // Only the exact result `ask` issued remembers its settlement, not a discarded or copied one.
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

/** Remembers a person's decision under the key its request named, replacing an earlier one. */
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

/** Whether `context` is the re-check of an approved call just before it runs. */
export function isApprovalRecheck(context: ApprovalContext): boolean {
  return approvalEvaluation(context)?.recheck === true;
}
