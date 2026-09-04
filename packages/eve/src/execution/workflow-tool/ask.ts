import type { OwnerInbox, InboxReplyTarget } from "#execution/inbox/types.js";
import { sendInboxStep } from "#execution/inbox/send.js";
import type {
  WorkflowToolRunOwner,
  WorkflowToolRunRef,
} from "#execution/workflow-tool/messages.js";
import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";

// `Symbol.for`, not a module-local WeakMap: `ask()` ships via the `eve/workflow`
// entry while `attachWorkflowToolRunContext` runs from `body.ts`, and those may
// be different bundled copies of this module.
const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

interface WorkflowToolRunContext {
  readonly inbox: OwnerInbox;
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

export function readWorkflowToolRunInbox(ctx: ToolContext): OwnerInbox {
  return readWorkflowToolRunContext(ctx).inbox;
}

export function createWorkflowReplyTarget(ctx: ToolContext, requestId: string): InboxReplyTarget {
  return { address: readWorkflowToolRunInbox(ctx).address, kind: "inbox", requestId };
}

/** Asks through the run's inbox; concurrent questions are correlated independently. */
export async function ask(ctx: ToolContext, request: ToolInputRequest): Promise<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx);
  const requestId = `${context.from.runId}:ask:${context.answerSeq++}`;
  const response = context.inbox.response(requestId, ctx.abortSignal).then(
    (envelope) => ({ kind: "reply" as const, envelope }),
    (error) => ({ kind: "error" as const, error }),
  );
  const delivered = await sendInboxStep(context.owner, {
    eventId: requestId,
    kind: "tool.request",
    payload: {
      from: context.from,
      replyTo: { address: context.inbox.address, kind: "inbox", requestId },
      request: { kind: "ask", request },
    },
  });
  if (delivered === "gone")
    throw new Error("The workflow tool owner ended before accepting input.");
  const received = await response;
  if (received.kind === "error") throw received.error;
  return received.envelope.payload as ToolInputResponse;
}
