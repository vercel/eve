import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type {
  WorkflowToolRunOwner,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
import { workflowToolContextErrorMessage } from "#shared/workflow-tool-context.js";

// `Symbol.for`, not a module-local WeakMap: workflow helpers and body setup may
// be different bundled copies of this module.
const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

export interface WorkflowToolRunContext {
  readonly canRequestInput?: boolean;
  /** The run and the call coordinates of its current generation. */
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunOwner;
  /** A resumable body replied and has not read again, so no generation owns new work. */
  readonly replied?: boolean;
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

/** The run context `ctx.agent` sends its requests with. */
export function readWorkflowToolRunAgentContext(ctx: ToolContext): WorkflowToolRunContext {
  return readWorkflowToolRunContext(ctx, "agent");
}

/**
 * Returns an answer which may be awaited or raced with another workflow
 * operation. A resumable body that replied has no generation to ask for
 * until it reads again, as for `ctx.agent`.
 */
export function ask(
  ctx: ToolContext,
  request: ToolInputRequest,
): Hook<ToolInputResponse> | Promise<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx, "ask");
  if (context.replied === true) {
    throw new Error(
      "ctx.ask() was called after ctx.reply(). The generation that replied has ended, so no one waits for its questions; call ctx.receive() first, or ask before replying.",
    );
  }
  if (context.canRequestInput === false) return Promise.resolve({ status: "unavailable" });
  const answer = createHook<ToolInputResponse>();
  void resumeHookStep(context.owner.inbox, {
    kind: "request",
    from: context.from,
    replyTo: answer.token,
    request: { kind: "ask", request },
  });
  return answer;
}
