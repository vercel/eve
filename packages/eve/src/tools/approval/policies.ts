import type { DecisionModel } from "#ai/decision-types.js";
import type { ApprovalContext, ApprovalPolicy } from "#approval/definition.js";
import type { AgentModelOptionsDefinition } from "#shared/agent-definition.js";
import { decide } from "#ai/decide.js";
import { approvalEvaluation } from "#approval/evaluation.js";
import { principalOf } from "#execution/session/principal.js";
import { parseJsonValue } from "#shared/json.js";

const MAX_ACTION_BYTES = 64 * 1024;

const DEFAULT_INSTRUCTIONS = `Review the exact tool action for dangerous effects. Return caution when it could cause meaningful harm, including destructive data loss, credential exposure, financial transactions, deployments or public changes, external communication, privilege or system changes, or concealed execution. Return clear for routine, low-impact actions. Judge the action's actual effects from its name and input. If important effects are unclear, return caution.`;
const DEFAULT_CLEAR_DESCRIPTION = "The action is routine and low impact.";
const DEFAULT_CAUTION_DESCRIPTION = "The action is dangerous or its important effects are unclear.";

export interface AutoApprovalOptions {
  /** Decision model instance or ID. Defaults to TypeSafe Jev. */
  readonly model?: DecisionModel;
  /** Provider options for the decision call. */
  readonly modelOptions?: Pick<AgentModelOptionsDefinition, "providerOptions">;
  /** Instructions used to classify the exact tool call. */
  readonly instructions?: string;
  /** Descriptions of the fixed approval outcomes. */
  readonly criteria?: {
    readonly clear?: string;
    readonly caution?: string;
  };
}

async function autoApproval(
  decisionModel: DecisionModel,
  options: AutoApprovalOptions,
  context: ApprovalContext,
): Promise<"approved" | "user-approval"> {
  try {
    const input = parseJsonValue(context.toolInput ?? null);
    const serializedInput = JSON.stringify(input);
    if (new TextEncoder().encode(serializedInput).byteLength > MAX_ACTION_BYTES) {
      return "user-approval";
    }
    const abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(30_000)]);
    const result = await decide({
      model: decisionModel,
      state: {
        action: {
          input,
          tool: context.toolName,
        },
      },
      questions: {
        permission: {
          type: "choice",
          instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
          criteria: {
            clear: options.criteria?.clear ?? DEFAULT_CLEAR_DESCRIPTION,
            caution: options.criteria?.caution ?? DEFAULT_CAUTION_DESCRIPTION,
          },
        },
      },
      signal: abortSignal,
      maxRetries: 0,
      providerOptions: options.modelOptions?.providerOptions,
    });
    return result.answers.permission.choice === "clear" ? "approved" : "user-approval";
  } catch {
    context.abortSignal.throwIfAborted();
    return "user-approval";
  }
}

/**
 * Returns an `approval` callback that asks an AI SDK decision model whether
 * the exact tool call presents concrete security danger. Defaults to TypeSafe Jev.
 * Unavailable or invalid decisions require user approval.
 */
export function auto<TInput = unknown>(options: AutoApprovalOptions = {}): ApprovalPolicy<TInput> {
  const decisionModel = options.model ?? "typesafe-ai/jev";
  return (context) => autoApproval(decisionModel, options, context as ApprovalContext);
}

/** When `always()` and `once()` ask. */
export interface MismatchApprovalOptions {
  /**
   * `"principal-mismatch"` asks only while the turn's caller, its latest sender, and the
   * session's initiator aren't all the same person. Only the caller can approve; anyone can deny.
   */
  readonly when: "principal-mismatch";
}

/**
 * Returns an `approval` callback that always requires user approval. With
 * `{ when: "principal-mismatch" }`, it asks only while someone other than the caller is involved.
 */
export function always<TInput = unknown>(
  options?: MismatchApprovalOptions,
): ApprovalPolicy<TInput> {
  if (mismatchOption(options, "always") === undefined) return () => "user-approval";
  return (context) => {
    const principals = mismatch(context as ApprovalContext);
    if (principals === undefined) return "not-applicable";
    const evaluation = approvalEvaluation(context as ApprovalContext);
    return evaluation === undefined
      ? "user-approval"
      : evaluation.ask(undefined, { callerApproves: true });
  };
}

/** Returns an `approval` callback that never requires user approval. */
export function never<TInput = unknown>(): ApprovalPolicy<TInput> {
  return () => "not-applicable";
}

/**
 * Remembers a person's approval for this tool for the rest of the session. With
 * `{ when: "principal-mismatch" }`, it asks once for each combination of caller, sender, and
 * initiator, and only while they aren't all the same person.
 */
export function once<TInput = unknown>(options?: MismatchApprovalOptions): ApprovalPolicy<TInput> {
  if (
    arguments.length > 1 ||
    (arguments.length === 1 && mismatchOption(options, "once") === undefined)
  ) {
    throw new TypeError(
      'once() accepts only { when: "principal-mismatch" }. Use a custom approval policy for input-dependent decisions.',
    );
  }
  if (options === undefined) {
    return (context) => {
      const evaluation = approvalEvaluation(context as ApprovalContext);
      if (evaluation === undefined) return "user-approval";
      const { entry, pending } = evaluation.read("once");
      // An approval still waiting on its own answer stays a separate question.
      return entry?.outcome === "accepted" && !pending
        ? "approved"
        : evaluation.ask({ key: "once" });
    };
  }
  return (context) => {
    const principals = mismatch(context as ApprovalContext);
    if (principals === undefined) return "not-applicable";
    const evaluation = approvalEvaluation(context as ApprovalContext);
    if (evaluation === undefined) return "user-approval";
    const key = onceKey(principals);
    const { entry, pending } = evaluation.read(key);
    if (entry?.outcome === "accepted" && !pending) return evaluation.confirmCaller();
    // Approving makes the caller the sender, so the decision also covers the narrower
    // combination that follows it; otherwise the very next call would ask again.
    const narrower = onceKey({ ...principals, sender: principals.current });
    return evaluation.ask(
      { key, ...(narrower !== key && { alsoKeys: [narrower] }) },
      { callerApproves: true },
    );
  };
}

interface Principals {
  readonly current: string;
  readonly initiator: string;
  readonly sender: string;
}

function mismatchOption(
  options: MismatchApprovalOptions | undefined,
  helper: "always" | "once",
): MismatchApprovalOptions | undefined {
  if (options === undefined) return undefined;
  if (
    typeof options !== "object" ||
    options === null ||
    options.when !== "principal-mismatch" ||
    Object.keys(options).length !== 1
  ) {
    throw new TypeError(`${helper}() accepts only { when: "principal-mismatch" }.`);
  }
  return options;
}

/** The three principals while they aren't all one person; `undefined` when they are. */
function mismatch(context: ApprovalContext): Principals | undefined {
  const { auth } = context.session;
  const principals = {
    current: principalOf(auth.current),
    initiator: principalOf(auth.initiator),
    sender: principalOf(auth.sender),
  };
  return principals.current === principals.sender && principals.current === principals.initiator
    ? undefined
    : principals;
}

function onceKey(principals: Principals): string {
  return JSON.stringify(["once", principals.current, principals.sender, principals.initiator]);
}
