import type { SessionContext } from "#context/session-context.js";
import type { ToolRunOwner } from "#execution/tool-run/messages.js";
import type { JsonObject } from "#shared/json.js";

export type ToolRunSessionContext = SessionContext["session"];

export interface ToolRunWorkflowInput {
  readonly callId: string;
  /** Deterministic per call: a replayed start re-derives it, loses the claim, and exits. */
  readonly hookToken: string;
  readonly input: JsonObject;
  readonly owner: ToolRunOwner;
  readonly session: ToolRunSessionContext;
  /** Harness step index of the model call that made this tool call. */
  readonly stepIndex: number;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface ToolRunAddress {
  readonly hookToken: string;
  readonly runId: string;
}

export const WORKFLOW_TOOL_EXECUTOR_KIND = "workflow-tool";
