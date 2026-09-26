import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolInputRequest } from "#tools/definition.js";

export interface WorkflowToolRunOwner {
  readonly inbox: string;
}

/**
 * A child authorization event the owner should display. Unlike input requests
 * it has no answer: the authorization callback completes against the child
 * directly, so the owner only re-emits it.
 */
export interface WorkflowToolAuthorizationRequest {
  readonly event: SubagentAuthorizationEventHookPayload;
  readonly kind: "authorization-request";
}

/** A question authored with `ask()` from `eve/workflow`, before owner normalization. */
export interface WorkflowToolAskRequest {
  readonly kind: "ask";
  readonly request: ToolInputRequest;
}

/**
 * A child subagent's pending input requests for one step, forwarded as a unit
 * so the owner resolves them against the same child step they came from.
 */
export interface WorkflowToolInputRequestBatch {
  readonly kind: "input-batch";
  readonly requests: readonly InputRequest[];
}

export type WorkflowToolRequest =
  | WorkflowToolAuthorizationRequest
  | WorkflowToolAskRequest
  | InputRequest
  | WorkflowToolInputRequestBatch;

/** Identifies the sending workflow tool run to an owner shared by many runs. */
export interface WorkflowToolRunRef {
  readonly callId: string;
  readonly input: JsonObject;
  readonly runId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  /** Set when the run does a task's work; the session routes its messages by it. */
  readonly taskId?: string;
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

/** A `ctx.ask()` request sent under `replyTo` was withdrawn before anyone answered it. */
export interface WorkflowToolRunWithdrawMessage {
  readonly from: WorkflowToolRunRef;
  readonly replyTo: string;
}

/** A session the run opened with `ctx.agent`, which the session announces as `agent.started`. */
export interface StartedAgentSession {
  readonly name: string;
  readonly remote?: { readonly resolverId?: string; readonly url: string };
  readonly sessionId: string;
}

export interface WorkflowToolRunAgentStartedMessage {
  readonly from: WorkflowToolRunRef;
  readonly session: StartedAgentSession;
}

/** A `serve` body's reply, sent once for each call it settles. */
export interface WorkflowToolRunReplyMessage {
  /** The call the reply settles. */
  readonly from: WorkflowToolRunRef;
  readonly output: JsonValue;
}

/** A task's run can take commands: its control hook is registered. */
export interface WorkflowToolRunStartedMessage {
  readonly from: WorkflowToolRunRef;
}

export type WorkflowToolRunMessage =
  | ({ readonly kind: "agent-started" } & WorkflowToolRunAgentStartedMessage)
  | ({ readonly kind: "started" } & WorkflowToolRunStartedMessage)
  | ({ readonly kind: "report" } & WorkflowToolRunReport)
  | ({ readonly kind: "reply" } & WorkflowToolRunReplyMessage)
  | ({ readonly kind: "request" } & WorkflowToolRunRequestMessage)
  | ({ readonly kind: "withdraw" } & WorkflowToolRunWithdrawMessage)
  | ({ readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage);

/** A later call to a `serve` task, which its run hands to `receive()`. */
export interface WorkflowToolRunCall {
  readonly callId: string;
  readonly executeInput?: JsonValue;
  /** The call's input, without the `taskId` that named the task. */
  readonly input: JsonObject;
}

/**
 * Commands the session sends a run on its control hook.
 *
 * - `cancel` stops the current work: an `execute` or `task` call's run, or a
 *   `serve` task's current stretch of work, after which it waits for more calls.
 * - `end` stops the run for good, because the session ended.
 * - `interrupt` aborts an `execute` call's `interruptSignal`, because steering
 *   arrived while the turn waits on the call.
 * - `call` delivers a later call to a `serve` task.
 */
export type WorkflowToolRunControlMessage =
  | { readonly kind: "call"; readonly call: WorkflowToolRunCall }
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "end"; readonly reason: string }
  | { readonly kind: "interrupt" };

export function isWorkflowToolRunControlMessage(
  value: unknown,
): value is WorkflowToolRunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const { call, kind, reason } = value as { call?: unknown; kind?: unknown; reason?: unknown };
  switch (kind) {
    case "interrupt":
      return true;
    case "cancel":
    case "end":
      return typeof reason === "string";
    case "call":
      return isWorkflowToolRunCall(call);
    default:
      return false;
  }
}

function isWorkflowToolRunCall(value: unknown): value is WorkflowToolRunCall {
  if (typeof value !== "object" || value === null) return false;
  const { callId, input } = value as { callId?: unknown; input?: unknown };
  return typeof callId === "string" && typeof input === "object" && input !== null;
}
