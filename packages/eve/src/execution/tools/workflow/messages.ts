import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import type { AgentSessionAddress } from "#execution/agent-sessions/steps.js";
import type {
  AgentInvocationRequest,
  AgentSettlementRequest,
} from "#execution/tools/subagent/invoke-agent.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type {
  ToolInputRequest,
  ToolInputResponse,
  ToolInputResponseResponder,
} from "#tools/definition.js";

export interface WorkflowToolRunOwner {
  readonly inbox: string;
}

/**
 * Requests the owner applies for the model's agent tools because they touch
 * owner-held state: spawning an agent and releasing its handle afterwards.
 */
export type WorkflowToolAgentRequest = AgentInvocationRequest | AgentSettlementRequest;

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
  /** The run's control hook, where the session sends its decision on the question. */
  readonly control: string;
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
  | WorkflowToolAgentRequest
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

/**
 * The run asks the session to withdraw the `ctx.ask()` question sent under
 * `replyTo`. The session answers `withdrawn` on `control`, unless it accepted
 * an answer first.
 */
export interface WorkflowToolRunWithdrawMessage {
  readonly control: string;
  readonly from: WorkflowToolRunRef;
  readonly replyTo: string;
}

/** The run opened a session with `ctx.agent`, which its session announces as `agent.started`. */
export interface WorkflowToolRunAgentStartedMessage {
  readonly from: WorkflowToolRunRef;
  readonly session: AgentSessionAddress;
}

export type WorkflowToolRunMessage =
  | ({ readonly kind: "agent-started" } & WorkflowToolRunAgentStartedMessage)
  | ({ readonly kind: "report" } & WorkflowToolRunReport)
  | ({ readonly kind: "request" } & WorkflowToolRunRequestMessage)
  | ({ readonly kind: "withdraw" } & WorkflowToolRunWithdrawMessage)
  | ({ readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage);

/** A person's answer to a `ctx.ask()` question, as the session accepted it. */
export type WorkflowToolRunAnswer = Extract<ToolInputResponse, { readonly status: "answered" }>;

/**
 * The session's decision on one `ctx.ask()` question: it accepted an answer,
 * or it withdrew the question first. It decides once, and the ask resolves
 * from that decision alone.
 */
export type WorkflowToolRunAskDecision =
  | {
      readonly kind: "answer";
      readonly requestId: string;
      readonly response: WorkflowToolRunAnswer;
    }
  | { readonly kind: "withdrawn"; readonly requestId: string };

/**
 * Commands the body applies, in the order the session sent them. `cancel`
 * aborts the call's `abortSignal`; `interrupt` aborts its `interruptSignal`,
 * because steering arrived while the turn waits on the call.
 */
export type WorkflowBodyCommand =
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "interrupt" };

/**
 * Everything the session sends a run, on the run's control hook: its one
 * inbox. Only the session writes to it, so the run receives commands and
 * decisions in the order the session made them.
 */
export type WorkflowToolRunControlMessage = WorkflowBodyCommand | WorkflowToolRunAskDecision;

export function isWorkflowToolRunControlMessage(
  value: unknown,
): value is WorkflowToolRunControlMessage {
  if (typeof value !== "object" || value === null) return false;
  const { kind, reason, requestId, response } = value as Record<string, unknown>;
  switch (kind) {
    case "interrupt":
      return true;
    case "cancel":
      return typeof reason === "string";
    case "answer":
      return typeof requestId === "string" && isWorkflowToolRunAnswer(response);
    case "withdrawn":
      return typeof requestId === "string";
    default:
      return false;
  }
}

export function isWorkflowToolRunAskDecision(
  message: WorkflowToolRunControlMessage,
): message is WorkflowToolRunAskDecision {
  return message.kind === "answer" || message.kind === "withdrawn";
}

function isWorkflowToolRunAnswer(value: unknown): value is WorkflowToolRunAnswer {
  if (typeof value !== "object" || value === null) return false;
  const { optionId, responder, status, text } = value as Record<string, unknown>;
  return (
    status === "answered" &&
    (optionId === undefined || typeof optionId === "string") &&
    (responder === undefined || isToolInputResponseResponder(responder)) &&
    (text === undefined || typeof text === "string")
  );
}

function isToolInputResponseResponder(value: unknown): value is ToolInputResponseResponder {
  if (typeof value !== "object" || value === null) return false;
  const { authenticator, principalId, principalType } = value as Record<string, unknown>;
  return (
    typeof authenticator === "string" &&
    typeof principalId === "string" &&
    typeof principalType === "string"
  );
}
