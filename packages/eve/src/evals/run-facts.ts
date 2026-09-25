import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

// What the runner derives from a session's stream: its tool calls, subagent
// delegations, and summary counts.

/** Lifecycle outcome of an eval-observed tool action. */
export type EveEvalActionStatus = "pending" | "completed" | "failed" | "rejected";

/**
 * One tool call extracted from the captured stream, pairing the
 * `actions.requested` request with its matching `action.result`.
 */
export interface EveEvalToolCall {
  /** Authored tool name (e.g. `"get_weather"`). */
  readonly name: string;
  /** Tool input as requested by the model. */
  readonly input: JsonObject;
  /** Tool output from the matching `action.result`; `undefined` when the call never resolved. */
  readonly output: JsonValue | undefined;
  /** Whether the request is unresolved, completed, failed, or user-rejected. */
  readonly status: EveEvalActionStatus;
  /** Zero-based index of the turn the call happened in. */
  readonly turnIndex: number;
  /** Owning session id, when the runner knows it. */
  readonly sessionId?: string;
}

/**
 * One subagent delegation extracted from the captured stream: one generation
 * of an agent task, its `task.started` joined with its `task.settled`.
 */
export interface EveEvalSubagentCall {
  /** Runtime-action call id joining this delegation's lifecycle events, when observed. */
  readonly callId?: string;
  /** Task ID from `task.started`; pass it as `taskId` to the agent's tool to continue it. */
  readonly taskId?: string;
  /** Task generation this call started: 1 for the task's first call, one more per later send. */
  readonly generation?: number;
  /** Set once the task ended (`task.ended`) and takes no more input. */
  readonly ended?: true;
  /** Durable child session id for local and remote delegations. */
  readonly childSessionId?: string;
  /** Subagent name. */
  readonly name: string;
  /** Remote agent URL for remote delegations (`task.started` child remote metadata). */
  readonly remoteUrl?: string;
  /**
   * Output from the matching `task.settled` event, or its error when the call
   * failed; `undefined` while the call is working.
   */
  readonly output?: JsonValue;
  /** Lifecycle status from the matching `task.settled` event; `working` until it arrives. */
  readonly status: "working" | "completed" | "failed" | "cancelled";
  /** Zero-based index of the turn the delegation happened in. */
  readonly turnIndex: number;
  /** Owning session id, when the runner knows it. */
  readonly sessionId?: string;
}

/**
 * Execution facts the runner extracts from a completed session's stream events.
 */
export interface EveEvalDerivedFacts {
  readonly toolCalls: readonly EveEvalToolCall[];
  readonly toolCallCount: number;
  readonly subagentCalls: readonly EveEvalSubagentCall[];
  readonly subagentCallCount: number;
  /** Every HITL input request raised during the run (`input.requested`). */
  readonly inputRequests: readonly InputRequest[];
  /** True when the run ended parked on unanswered HITL input requests. */
  readonly parked: boolean;
  /** Assistant messages that ended a step without tool calls, except a held turn's interim ones. */
  readonly messageCount: number;
  readonly reasoningBlockCount: number;
  readonly failureCode?: string;
}
