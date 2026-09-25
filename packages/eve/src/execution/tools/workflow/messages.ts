import type { AgentInvocationRequest } from "#execution/tools/workflow/agent.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TaskInputEvent } from "#tasks/protocol.js";
import type { ToolInputRequest } from "#tools/definition.js";

export interface WorkflowToolRunOwner {
  readonly inbox: string;
}

/** Starting an agent needs owner-held state, so the owner applies it on the run's behalf. */
export type WorkflowToolAgentRequest = AgentInvocationRequest;

/** A `ctx.agent` call whose `signal` aborted: the owner cancels that call's task. */
export interface WorkflowToolAgentCancelRequest {
  readonly invocationId: string;
  readonly kind: "agent-cancel";
}

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
  | WorkflowToolAgentCancelRequest
  | WorkflowToolAuthorizationRequest
  | WorkflowToolAskRequest;

/**
 * Identifies the sending workflow tool run to an owner shared by many runs,
 * with the call coordinates of the generation it sends for. A resumable run's
 * later generations carry the call of the send that started them.
 */
export interface WorkflowToolRunRef {
  readonly callId: string;
  readonly generation: number;
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

/**
 * A resumable run's lifecycle. `started` reports a generation the body began
 * by reading a send (`send` is its number); `reply` settles one generation
 * while the run stays alive (`read` lists the sends the body read during
 * it); `ended` follows the last generation and lists the sends the body
 * never read. A non-resumable run reports one `outcome` instead.
 */
export type WorkflowToolRunGenerationMessage =
  | {
      readonly kind: "started";
      readonly from: Omit<WorkflowToolRunRef, "input">;
      readonly send: number;
    }
  | {
      readonly kind: "reply";
      readonly from: Omit<WorkflowToolRunRef, "input">;
      readonly result: WorkflowToolRunOutcome;
      readonly read: readonly number[];
    }
  | {
      readonly kind: "ended";
      readonly from: Omit<WorkflowToolRunRef, "input">;
      readonly unread: readonly number[];
    };

export type WorkflowToolRunMessage =
  | ({ readonly kind: "report" } & WorkflowToolRunReport)
  | ({ readonly kind: "request" } & WorkflowToolRunRequestMessage)
  | ({ readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage)
  | WorkflowToolRunGenerationMessage;

/** The call a send came from; the generation it starts takes its context. */
export interface WorkflowToolRunSendCall {
  readonly callId: string;
  readonly stepIndex: number;
  readonly turn: { readonly id: string; readonly sequence: number };
}

/**
 * Owner → run, on the run's one command hook, so cancels and sends share one
 * order. A resumable run's `cancel` stops only its current generation and
 * the sends queued for it unless `end` is set; any other run ends. `input` is
 * a send, numbered by the owner; a resumable run drops a repeated number.
 */
export type WorkflowToolRunControlMessage =
  | { readonly kind: "cancel"; readonly reason: string; readonly end?: true }
  | {
      readonly kind: "input";
      readonly seq: number;
      readonly input: JsonObject;
      readonly call: WorkflowToolRunSendCall;
    };

export function isWorkflowToolRunControlMessage(
  value: unknown,
): value is WorkflowToolRunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.kind === "cancel") {
    return (
      typeof message.reason === "string" && (message.end === undefined || message.end === true)
    );
  }
  const call = message.call as Record<string, unknown> | undefined;
  const turn = call?.turn as Record<string, unknown> | undefined;
  return (
    message.kind === "input" &&
    typeof message.seq === "number" &&
    Number.isSafeInteger(message.seq) &&
    message.seq > 0 &&
    typeof message.input === "object" &&
    message.input !== null &&
    !Array.isArray(message.input) &&
    typeof call?.callId === "string" &&
    typeof call.stepIndex === "number" &&
    typeof turn?.id === "string" &&
    typeof turn.sequence === "number"
  );
}
