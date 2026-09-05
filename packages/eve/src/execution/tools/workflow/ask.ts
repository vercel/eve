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
  /** Compatibility for already-started two-run background workflows. */
  readonly admission?: Promise<
    { readonly status: "accepted" } | { readonly status: "rejected"; readonly reason: string }
  >;
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

export function readWorkflowToolRunAdmission(
  ctx: ToolContext,
): WorkflowToolRunContext["admission"] {
  return readWorkflowToolRunContext(ctx, "agent").admission;
}

/** Returns an answer hook which may be awaited or raced with another workflow operation. */
export function ask(ctx: ToolContext, request: ToolInputRequest): Hook<ToolInputResponse> {
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
