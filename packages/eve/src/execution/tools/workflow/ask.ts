import { createHook } from "#compiled/@workflow/core/index.js";

import type {
  WorkflowToolRunOwner,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type {
  ToolContext,
  ToolInputRequest,
  ToolInputRequestOptions,
  ToolInputResponse,
} from "#tools/definition.js";
import { workflowToolContextErrorMessage } from "#shared/workflow-tool-context.js";

// `Symbol.for`, not a module-local WeakMap: workflow helpers and body setup may
// be different bundled copies of this module.
const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

export interface WorkflowToolRunContext {
  readonly canRequestInput?: boolean;
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunOwner;
}

type WorkflowToolRunContextCarrier = {
  readonly [WORKFLOW_TOOL_RUN_CONTEXT]?: WorkflowToolRunContext;
};

export function attachWorkflowToolRunContext(
  ctx: ToolContext,
  context: WorkflowToolRunContext,
): void {
  Object.defineProperty(ctx, WORKFLOW_TOOL_RUN_CONTEXT, {
    enumerable: false,
    value: context,
  });
}

function readWorkflowToolRunContext(
  ctx: ToolContext,
  helper: "agent" | "ask",
): WorkflowToolRunContext {
  const context = (ctx as WorkflowToolRunContextCarrier | undefined)?.[WORKFLOW_TOOL_RUN_CONTEXT];
  if (context === undefined) {
    throw new Error(workflowToolContextErrorMessage(helper));
  }
  return context;
}

export function findWorkflowToolRunContext(value: unknown): WorkflowToolRunContext | undefined {
  return typeof value === "object" && value !== null
    ? (value as WorkflowToolRunContextCarrier)[WORKFLOW_TOOL_RUN_CONTEXT]
    : undefined;
}

export function readWorkflowToolRunRef(ctx: ToolContext): WorkflowToolRunRef {
  return readWorkflowToolRunContext(ctx, "agent").from;
}

export function readWorkflowToolRunOwner(ctx: ToolContext): WorkflowToolRunOwner {
  return readWorkflowToolRunContext(ctx, "agent").owner;
}

const CANCELLED: ToolInputResponse = { status: "cancelled" };
const UNAVAILABLE: ToolInputResponse = { status: "unavailable" };

/**
 * Returns an answer which may be awaited or raced with another workflow
 * operation. When the call's `abortSignal` or `options.signal` aborts before
 * an answer arrives, the request is withdrawn and the answer is `cancelled`.
 */
export function ask(
  ctx: ToolContext,
  request: ToolInputRequest,
  options: ToolInputRequestOptions = {},
): Promise<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx, "ask");
  if (context.canRequestInput === false) return Promise.resolve(UNAVAILABLE);
  const signals = [ctx.abortSignal];
  if (options.signal !== undefined) signals.push(options.signal);
  if (signals.some((signal) => signal.aborted)) return Promise.resolve(CANCELLED);

  const answer = createHook<ToolInputResponse>();
  const sent = resumeHookStep(context.owner.inbox, {
    kind: "request",
    from: context.from,
    replyTo: answer.token,
    request: { kind: "ask", request },
  });
  const withdraw = async (): Promise<void> => {
    // The request may still be in flight; the withdrawal must not overtake it.
    await sent;
    await resumeHookStep(context.owner.inbox, {
      kind: "withdraw",
      from: context.from,
      replyTo: answer.token,
    });
  };
  return answerUnlessWithdrawn(answer, signals, withdraw);
}

/** Resolves with the answer, or as `cancelled` once a signal aborts first and the request is withdrawn. */
function answerUnlessWithdrawn(
  answer: PromiseLike<ToolInputResponse>,
  signals: readonly AbortSignal[],
  withdraw: () => Promise<void>,
): Promise<ToolInputResponse> {
  let answered = false;
  const answering = Promise.resolve(answer).then((response) => {
    answered = true;
    return response;
  });
  const withdrawing = firstAbort(signals).then(async () => {
    if (!answered) await withdraw();
    return CANCELLED;
  });
  return Promise.race([answering, withdrawing]);
}

function firstAbort(signals: readonly AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    for (const signal of signals) {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}
