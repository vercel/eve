import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type {
  WorkflowToolRunOwner,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { workflowToolRunAnswerToken } from "#harness/workflow-tool-runs.js";
import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";

// `Symbol.for`, not a module-local WeakMap: `ask()` ships via the `eve/workflow`
// entry while `attachWorkflowToolRunContext` runs from `body.ts`, and those may
// be different bundled copies of this module.
const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

interface WorkflowToolRunContext {
  /** Compatibility for already-started two-run background workflows. */
  readonly admission?: Promise<
    { readonly status: "accepted" } | { readonly status: "rejected"; readonly reason: string }
  >;
  answerSeq: number;
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunOwner;
}

type WorkflowToolRunContextCarrier = {
  readonly [WORKFLOW_TOOL_RUN_CONTEXT]?: WorkflowToolRunContext;
};

export function attachWorkflowToolRunContext(
  ctx: ToolContext,
  context: Omit<WorkflowToolRunContext, "answerSeq">,
): void {
  Object.defineProperty(ctx, WORKFLOW_TOOL_RUN_CONTEXT, {
    enumerable: false,
    value: { ...context, answerSeq: 0 },
  });
}

function readWorkflowToolRunContext(ctx: ToolContext): WorkflowToolRunContext {
  const context = (ctx as WorkflowToolRunContextCarrier)[WORKFLOW_TOOL_RUN_CONTEXT];
  if (context === undefined) {
    throw new Error(
      'This function must be called with the context of a workflow tool body ("use workflow").',
    );
  }
  return context;
}

export function readWorkflowToolRunRef(ctx: ToolContext): WorkflowToolRunRef {
  return readWorkflowToolRunContext(ctx).from;
}

export function readWorkflowToolRunOwner(ctx: ToolContext): WorkflowToolRunOwner {
  return readWorkflowToolRunContext(ctx).owner;
}

export function readWorkflowToolRunAdmission(
  ctx: ToolContext,
): WorkflowToolRunContext["admission"] {
  return readWorkflowToolRunContext(ctx).admission;
}

/** Returns an answer hook which may be awaited or raced with another workflow operation. */
export function ask(ctx: ToolContext, request: ToolInputRequest): Hook<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx);
  const answer = createHook<ToolInputResponse>({
    token: workflowToolRunAnswerToken(context.from.runId, context.answerSeq++),
  });
  void resumeHookStep(context.owner.request, {
    from: context.from,
    replyTo: answer.token,
    request: { kind: "ask", request },
  });
  return answer;
}
