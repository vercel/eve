import type { SessionParent, SessionTurn } from "#channel/types.js";
import type { SessionAuth } from "#context/keys.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Where a tool run reports: the parked turn waiting for the tool's result, or
 * the durable task that owns a background tool call. `RunMessage`s are resumed
 * on the named hook.
 */
export type ToolRunReplyTo =
  | { readonly kind: "turn"; readonly inboxToken: string }
  | {
      readonly kind: "task";
      readonly taskId: string;
      readonly taskInboxToken: string;
      readonly taskRunId: string;
    };

/** The session projection an authored workflow body observes as `ctx.session`. */
export interface ToolRunSessionContext {
  readonly auth: SessionAuth;
  readonly id: string;
  readonly parent?: SessionParent;
  readonly turn: SessionTurn;
}

/** Input for one authored workflow tool run. Dependency-free: bundled into the driver. */
export interface ToolRunWorkflowInput {
  readonly callId: string;
  /**
   * Deterministic token of the run's own hook: its identity claim and the
   * address its owner cancels it on. A replayed start re-derives the same
   * token, loses the claim, and exits, so one tool call never runs twice.
   */
  readonly hookToken: string;
  readonly input: JsonObject;
  readonly replyTo: ToolRunReplyTo;
  readonly session: ToolRunSessionContext;
  /** Harness step index of the model call that made this tool call. */
  readonly stepIndex: number;
  readonly toolName: string;
  /** Id of the authored `"use workflow"` function the driver registered for `execute`. */
  readonly workflowId: string;
}

/** Executor binding kind recorded on durable tasks whose executor is a tool run. */
export const WORKFLOW_TOOL_EXECUTOR_KIND = "workflow-tool";

export interface WorkflowToolExecutorData {
  readonly hookToken: string;
  readonly runId: string;
}
