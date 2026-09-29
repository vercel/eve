import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessionAddress } from "#execution/agent-sessions/steps.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type {
  ToolInputRequest,
  ToolInputResponse,
  ToolInputResponseResponder,
} from "#tools/definition.js";

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

/**
 * A `serve` body's reply, sent once for each `ctx.reply()`. It settles every
 * call the body received since its last reply, so the session settles them
 * together and the model receives the reply once.
 */
export interface WorkflowToolRunReplyMessage {
  /** The calls the reply settles, oldest first. */
  readonly callIds: readonly string[];
  /** The latest call the reply settles, which the body serves now. */
  readonly from: WorkflowToolRunRef;
  readonly output: JsonValue;
}

/** A task's run can take commands: its control hook is registered. */
export interface WorkflowToolRunStartedMessage {
  readonly from: WorkflowToolRunRef;
}

/**
 * What the run's `ctx.agent` sessions have spent so far, sent after each of
 * their turns ends. `usage` is the run's running total and `sequence` numbers
 * the reports, so the session counts each turn once even when a report is
 * delivered twice or overtakes an earlier one.
 */
export interface WorkflowToolRunUsageMessage {
  readonly from: WorkflowToolRunRef;
  readonly sequence: number;
  readonly usage: TokenUsage;
}

export type WorkflowToolRunMessage =
  | ({ readonly kind: "agent-started" } & WorkflowToolRunAgentStartedMessage)
  | ({ readonly kind: "started" } & WorkflowToolRunStartedMessage)
  | ({ readonly kind: "report" } & WorkflowToolRunReport)
  | ({ readonly kind: "reply" } & WorkflowToolRunReplyMessage)
  | ({ readonly kind: "request" } & WorkflowToolRunRequestMessage)
  | ({ readonly kind: "withdraw" } & WorkflowToolRunWithdrawMessage)
  | ({ readonly kind: "usage" } & WorkflowToolRunUsageMessage)
  | ({ readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage);

/**
 * A later call to a `serve` task, which its run hands to `receive()`. It
 * carries everything the session knew of the call when it admitted it, as a
 * run's input does for the call that started it: the coordinates of the model
 * step that made it, the caller's auth, and the context of sessions opened
 * for it, with the agents it may open. Everything the run does while serving
 * the call comes from these.
 */
export interface WorkflowToolRunCall extends Pick<
  WorkflowToolRunRef,
  "callId" | "sequence" | "stepIndex" | "turnId"
> {
  /** Sessions opened while serving the call are its children, in its trace. */
  readonly agentContext: AgentSessionContext;
  /** The caller's auth the session admitted the call with, which messages sent while serving it carry. */
  readonly auth: SessionAuth;
  readonly executeInput?: JsonValue;
  /** The call's input, without the `taskId` that named the task. */
  readonly input: JsonObject;
}

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
 * Commands the body applies, in the order the session sent them.
 *
 * - `cancel` stops the current work: an `execute` or `task` call's run, or a
 *   `serve` task's current stretch of work, after which it waits for more calls.
 * - `end` stops the run for good, because the session ended.
 * - `interrupt` aborts an `execute` call's `abortSignal` without cancelling the
 *   call, because steering arrived while the turn waits on it.
 * - `call` delivers a later call to a `serve` task.
 */
export type WorkflowBodyCommand =
  | { readonly kind: "call"; readonly call: WorkflowToolRunCall }
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "end"; readonly reason: string }
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
  const { call, kind, reason, requestId, response } = value as Record<string, unknown>;
  switch (kind) {
    case "interrupt":
      return true;
    case "cancel":
    case "end":
      return typeof reason === "string";
    case "call":
      return isWorkflowToolRunCall(call);
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

function isWorkflowToolRunCall(value: unknown): value is WorkflowToolRunCall {
  if (typeof value !== "object" || value === null) return false;
  const { agentContext, auth, callId, input, sequence, stepIndex, turnId } = value as Record<
    string,
    unknown
  >;
  return (
    typeof agentContext === "object" &&
    agentContext !== null &&
    typeof auth === "object" &&
    auth !== null &&
    typeof callId === "string" &&
    typeof input === "object" &&
    input !== null &&
    typeof sequence === "number" &&
    typeof stepIndex === "number" &&
    typeof turnId === "string"
  );
}
