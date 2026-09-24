import type { AgentInvocationRequest } from "#execution/tools/workflow/agent.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TaskInputEvent } from "#tasks/protocol.js";
import type { ToolInputRequest } from "#tools/definition.js";

export interface WorkflowToolRunOwner {
  readonly inbox: string;
}

/** Starting an agent needs owner-held state, so the owner applies it on the run's behalf. */
export type WorkflowToolAgentRequest = AgentInvocationRequest;

/**
 * A sign-in the owner should display. Unlike a question it has no answer:
 * the authorization callback completes against the run directly, so the
 * owner only surfaces it, then acknowledges it on `replyTo`.
 */
export interface WorkflowToolAuthorizationRequest {
  readonly event: Extract<
    TaskInputEvent,
    { readonly type: "authorization.required" | "authorization.completed" }
  >;
  readonly kind: "authorization-request";
}

/** A question authored with `ask()` from `eve/workflow`, before owner normalization. */
export interface WorkflowToolAskRequest {
  readonly kind: "ask";
  readonly request: ToolInputRequest;
}

export type WorkflowToolRequest =
  | WorkflowToolAgentRequest
  | WorkflowToolAuthorizationRequest
  | WorkflowToolAskRequest;

/** Identifies the sending workflow tool run to an owner shared by many runs. */
export interface WorkflowToolRunRef {
  readonly callId: string;
  readonly input: JsonObject;

  readonly runId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly taskId: string;
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
}

/**
 * An outcome names its run without the call's input: the owner settles the
 * call by task, and the run keeps the message as its return value.
 */
export interface WorkflowToolRunOutcomeMessage {
  readonly from: Omit<WorkflowToolRunRef, "input">;
  readonly result: WorkflowToolRunOutcome;
}

export type WorkflowToolRunMessage =
  | ({ readonly kind: "report" } & WorkflowToolRunReport)
  | ({ readonly kind: "request" } & WorkflowToolRunRequestMessage)
  | ({ readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage);

export type WorkflowToolRunControlMessage = { readonly kind: "cancel"; readonly reason: string };

export function isWorkflowToolRunControlMessage(
  value: unknown,
): value is WorkflowToolRunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const { kind, reason } = value as { kind?: unknown; reason?: unknown };
  return kind === "cancel" && typeof reason === "string";
}
