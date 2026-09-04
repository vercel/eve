import type { ReplyTarget } from "#execution/inbox/types.js";

import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import type {
  AgentInvocationRequest,
  AgentSettlementRequest,
} from "#execution/tools/subagent/invoke-agent.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolInputRequest } from "#tools/definition.js";

/**
 * Requests the owner must apply on the run's behalf because they touch
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
interface WorkflowToolAskRequest {
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
  readonly execution: "background" | "blocking";
  readonly input: JsonObject;
  readonly resultKind?: "subagent" | "tool";
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
  readonly replyTo: ReplyTarget;
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
