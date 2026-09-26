import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type {
  WorkflowToolRunOwner,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { ToolInputRequest, ToolInputResponse } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import { workflowToolContextErrorMessage } from "#shared/workflow-tool-context.js";

// `Symbol.for`, not a module-local WeakMap: workflow helpers and body setup may
// be different bundled copies of this module.
const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

export interface WorkflowToolRunContext {
  /** The call's signal, for framework waits the body starts on the call's behalf. */
  readonly abortSignal: AbortSignal;
  readonly canRequestInput?: boolean;
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunOwner;
}

type WorkflowToolRunContextCarrier = {
  readonly [WORKFLOW_TOOL_RUN_CONTEXT]?: WorkflowToolRunContext;
};

export function attachWorkflowToolRunContext(
  ctx: WorkflowToolContext,
  context: WorkflowToolRunContext,
): void {
  Object.defineProperty(ctx, WORKFLOW_TOOL_RUN_CONTEXT, {
    enumerable: false,
    value: context,
  });
}

function readWorkflowToolRunContext(
  ctx: WorkflowToolContext,
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

export function readWorkflowToolRunRef(ctx: WorkflowToolContext): WorkflowToolRunRef {
  return readWorkflowToolRunContext(ctx, "agent").from;
}

export function readWorkflowToolRunOwner(ctx: WorkflowToolContext): WorkflowToolRunOwner {
  return readWorkflowToolRunContext(ctx, "agent").owner;
}

export function readWorkflowToolRunSignal(ctx: WorkflowToolContext): AbortSignal {
  return readWorkflowToolRunContext(ctx, "agent").abortSignal;
}

/** Returns an answer which may be awaited or raced with another workflow operation. */
export function ask(
  ctx: WorkflowToolContext,
  request: ToolInputRequest,
): Hook<ToolInputResponse> | Promise<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx, "ask");
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
