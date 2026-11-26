import type { Principal } from "#protocol/session-events/envelope.js";
import type { SubagentInteractionHookPayload } from "#channel/types.js";
import type { SessionAuth } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { AgentSessionAddress } from "#execution/agent-sessions/start.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { ToolQuestion, ToolAnswer } from "#tools/definition.js";

export interface WorkflowToolRunOwner {
  readonly inbox: string;
}

export interface WorkflowToolRelay {
  readonly event: SubagentInteractionHookPayload;
  readonly kind: "relay";
}

export interface WorkflowToolAskRequest {
  readonly control: string;
  readonly kind: "ask";
  readonly request: ToolQuestion;
}

export type WorkflowToolRequest = WorkflowToolRelay | WorkflowToolAskRequest;

export interface WorkflowToolRunRef {
  readonly callId: string;
  readonly input?: JsonObject;
  readonly runId: string;
  readonly sequence: number;
  readonly stepIndex: number;
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

export type WorkflowToolRunRequestMessage =
  | {
      readonly from: WorkflowToolRunRef;
      readonly replyTo: string;
      readonly request: WorkflowToolAskRequest;
    }
  | {
      readonly from: WorkflowToolRunRef;
      readonly replyTo?: string;
      readonly request: WorkflowToolRelay;
    };

export interface WorkflowToolRunOutcomeMessage {
  readonly from: WorkflowToolRunRef;
  readonly result: WorkflowToolRunOutcome;
  readonly usage?: TokenUsage;
}

export interface WorkflowToolRunWithdrawMessage {
  readonly control: string;
  readonly from: WorkflowToolRunRef;
  readonly replyTo: string;
}

export interface WorkflowToolRunAgentStartedMessage {
  readonly from: WorkflowToolRunRef;
  readonly session: AgentSessionAddress;
  readonly context: AgentSessionContext;
}

export interface WorkflowToolRunAgentSentMessage {
  readonly from: WorkflowToolRunRef;
  readonly sessionId: string;
  readonly deliveryId: string;
}

export interface WorkflowToolRunReplyMessage {
  readonly callIds: readonly string[];
  readonly from: WorkflowToolRunRef;
  readonly output: JsonValue;
  readonly usage?: TokenUsage;
}

export interface WorkflowToolRunUsageMessage {
  readonly from: WorkflowToolRunRef;
  readonly usage: TokenUsage;
}

export interface WorkflowToolRunStartedMessage {
  readonly from: WorkflowToolRunRef;
}

export type WorkflowToolRunMessage =
  | ({ readonly kind: "agent-started" } & WorkflowToolRunAgentStartedMessage)
  | ({ readonly kind: "agent-sent" } & WorkflowToolRunAgentSentMessage)
  | ({ readonly kind: "started" } & WorkflowToolRunStartedMessage)
  | ({ readonly kind: "report" } & WorkflowToolRunReport)
  | ({ readonly kind: "reply" } & WorkflowToolRunReplyMessage)
  | ({ readonly kind: "request" } & WorkflowToolRunRequestMessage)
  | ({ readonly kind: "withdraw" } & WorkflowToolRunWithdrawMessage)
  | ({ readonly kind: "usage" } & WorkflowToolRunUsageMessage)
  | ({ readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage);

export function isAgentSessionMessage(
  message: WorkflowToolRunMessage,
): message is Extract<WorkflowToolRunMessage, { readonly kind: "agent-started" | "agent-sent" }> {
  return message.kind === "agent-started" || message.kind === "agent-sent";
}

export interface WorkflowToolRunMessageBatch {
  readonly kind: "workflow-batch";
  readonly messages: readonly WorkflowToolRunMessage[];
}

const RUN_MESSAGE_BATCH_MAX_CHARS = 64_000;

export function runMessageBatchBudget(): (message: WorkflowToolRunMessage) => boolean {
  let used = 0;
  let admitted = false;
  return (message) => {
    const size = serializedLength(message);
    if (admitted && used + size > RUN_MESSAGE_BATCH_MAX_CHARS) return false;
    used += size;
    admitted = true;
    return true;
  };
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface WorkflowToolRunCall extends Pick<
  WorkflowToolRunRef,
  "callId" | "sequence" | "stepIndex" | "turnId"
> {
  readonly agentContext: AgentSessionContext;
  readonly auth: SessionAuth;
  readonly executeInput?: JsonValue;
  readonly input: JsonObject;
}

export type WorkflowToolRunAnswer = Extract<ToolAnswer, { readonly status: "answered" }>;

export type WorkflowToolRunAskDecision =
  | {
      readonly kind: "answer";
      readonly requestId: string;
      readonly response: WorkflowToolRunAnswer;
    }
  | { readonly kind: "withdrawn"; readonly requestId: string };

export type WorkflowBodyCommand =
  | { readonly kind: "call"; readonly call: WorkflowToolRunCall }
  | { readonly kind: "cancel"; readonly reason: string }
  | { readonly kind: "end"; readonly reason: string }
  | { readonly kind: "interrupt" };

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
    (responder === undefined || isPrincipal(responder)) &&
    (text === undefined || typeof text === "string")
  );
}

function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null) return false;
  const { id, type, issuer } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof type === "string" &&
    (issuer === undefined || typeof issuer === "string")
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
