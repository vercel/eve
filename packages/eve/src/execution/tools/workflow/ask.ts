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
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunOwner;
}

type WorkflowToolRunContextCarrier = {
  readonly [WORKFLOW_TOOL_RUN_CONTEXT]?: WorkflowToolRunContext;
};

export function attachWorkflowToolRunContext(
  ctx: Omit<ToolContext, "agent">,
  context: WorkflowToolRunContext,
): void {
  Object.defineProperty(ctx, WORKFLOW_TOOL_RUN_CONTEXT, {
    enumerable: false,
    value: context,
  });
}

function readWorkflowToolRunContext(
  ctx: Omit<ToolContext, "agent">,
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

export function readWorkflowToolRunRef(ctx: Omit<ToolContext, "agent">): WorkflowToolRunRef {
  return readWorkflowToolRunContext(ctx, "agent").from;
}

export function readWorkflowToolRunOwner(ctx: Omit<ToolContext, "agent">): WorkflowToolRunOwner {
  return readWorkflowToolRunContext(ctx, "agent").owner;
}

/** Returns an answer hook which may be awaited or raced with another workflow operation. */
export function ask(
  ctx: Omit<ToolContext, "agent">,
  request: ToolInputRequest,
): Hook<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx, "ask");
  const answer = createHook<ToolInputResponse>();
  void resumeHookStep(context.owner.inbox, {
    kind: "request",
    from: context.from,
    replyTo: answer.token,
    request: { kind: "ask", request },
  });
  return answer;
}
