import { createHook, defineHook, type Hook } from "#compiled/@workflow/core/index.js";

import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { workflowToolRunAnswerToken } from "#harness/workflow-tool-runs.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolContext, ToolInputRequest, ToolInputResponse } from "#tools/definition.js";

export interface WorkflowToolRunOwner {
  readonly outcome: string;
  readonly report: string;
  readonly request: string;
}

export interface WorkflowToolEffectRequest {
  readonly input: unknown;
  readonly invocationId?: string;
  readonly kind: "effect";
  readonly name: string;
}

export type WorkflowToolRequest = WorkflowToolEffectRequest | ToolInputRequest | InputRequest;

export function isWorkflowToolEffectRequest(
  value: WorkflowToolRequest,
): value is WorkflowToolEffectRequest {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "effect";
}

/** Identifies the sending workflow tool run to an owner shared by many runs. */
export interface WorkflowToolRunRef {
  readonly callId: string;
  readonly execution?: "background" | "blocking";
  readonly input: JsonObject;
  readonly resultKind?: "subagent" | "tool";
  readonly runId: string;
  readonly stepIndex: number;
  readonly toolName: string;
  readonly turnId: string;
}

export type WorkflowToolRunOutcome =
  | { readonly status: "completed"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled"; readonly reason?: string };

export interface WorkflowToolRunReport {
  readonly from: WorkflowToolRunRef;
  readonly update: JsonValue;
}

export interface WorkflowToolRunRequestMessage {
  readonly from: WorkflowToolRunRef;
  readonly replyTo: string;
  readonly request: WorkflowToolRequest;
  readonly requestCoordinates?: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
}

export interface WorkflowToolRunOutcomeMessage {
  readonly from: WorkflowToolRunRef;
  readonly result: WorkflowToolRunOutcome;
}

export const workflowToolRunReportHook = defineHook<WorkflowToolRunReport>();
export const workflowToolRunRequestHook = defineHook<WorkflowToolRunRequestMessage>();
export const workflowToolRunOutcomeHook = defineHook<WorkflowToolRunOutcomeMessage>();

export function deriveWorkflowToolRunOwner(inboxToken: string): WorkflowToolRunOwner {
  return {
    outcome: `${inboxToken}:outcome`,
    report: `${inboxToken}:report`,
    request: `${inboxToken}:request`,
  };
}

export type WorkflowToolRunControlMessage = { readonly kind: "cancel"; readonly reason: string };

export function isWorkflowToolRunControlMessage(
  value: unknown,
): value is WorkflowToolRunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const { kind, reason } = value as { kind?: unknown; reason?: unknown };
  return kind === "cancel" && typeof reason === "string";
}

const WORKFLOW_TOOL_RUN_CONTEXT = Symbol.for("eve.workflow-tool-run.context");

interface WorkflowToolRunContext {
  answerSeq: number;
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunOwner;
}

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
  const context = (ctx as { [WORKFLOW_TOOL_RUN_CONTEXT]?: WorkflowToolRunContext })[
    WORKFLOW_TOOL_RUN_CONTEXT
  ];
  if (context === undefined) {
    throw new Error(
      'ask() must be called with the context of a workflow tool body ("use workflow").',
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

/** Returns an answer hook which may be awaited or raced with another workflow operation. */
export function ask(ctx: ToolContext, request: ToolInputRequest): Hook<ToolInputResponse> {
  const context = readWorkflowToolRunContext(ctx);
  const answer = createHook<ToolInputResponse>({
    token: workflowToolRunAnswerToken(context.from.runId, context.answerSeq++),
  });
  void resumeHookStep(context.owner.request, {
    from: context.from,
    replyTo: answer.token,
    request,
  });
  return answer;
}
