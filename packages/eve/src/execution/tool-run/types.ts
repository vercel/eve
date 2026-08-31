import type { SessionContext } from "#context/session-context.js";
import type { ToolRunOwner } from "#execution/tool-run/messages.js";
import type { JsonObject } from "#shared/json.js";

/** The session an authored workflow body observes as `ctx.session`. */
export type ToolRunSessionContext = SessionContext["session"];

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
  /** Id of the authored `"use workflow"` function the driver registered for `execute`. */
  readonly workflowId: string;
}

/** Where a started tool run lives: the run and the hook its owner controls it on. */
export interface ToolRunAddress {
  readonly hookToken: string;
  readonly runId: string;
}

/** Executor binding kind recorded on durable tasks whose executor is a tool run. */
export const WORKFLOW_TOOL_EXECUTOR_KIND = "workflow-tool";
