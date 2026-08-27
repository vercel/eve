import type { SessionParent, SessionTurn } from "#channel/types.js";
import type { SessionAuth } from "#context/keys.js";
import type { JsonObject } from "#shared/json.js";
import type { ToolRunOwner } from "#tools/definition.js";

/** Private descriptor consumed only by eve's shared subagent execute body. */
export interface SubagentToolRunDescriptor {
  /** Hook the child reports results and blocking events to. */
  readonly replyToken: string;
  /** Authored subagent name used to bind relay failures and events. */
  readonly subagentName: string;
}

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
  /** Channels of the turn or task that started the run; see {@link ToolRunOwner}. */
  readonly owner: ToolRunOwner;
  readonly session: ToolRunSessionContext;
  /** Harness step index of the model call that made this tool call. */
  readonly stepIndex: number;
  readonly toolName: string;
  /** Present only for eve's framework-owned subagent execute workflow. */
  readonly subagent?: SubagentToolRunDescriptor;
  /** Id of the authored `"use workflow"` function the driver registered for `execute`. */
  readonly workflowId: string;
}

/** Executor binding kind recorded on durable tasks whose executor is a tool run. */
export const WORKFLOW_TOOL_EXECUTOR_KIND = "workflow-tool";

export interface WorkflowToolExecutorData {
  readonly hookToken: string;
  readonly runId: string;
}
