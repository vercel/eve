import type { SessionContext } from "#context/session-context.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { InboxAddress } from "#execution/inbox/types.js";

export interface WorkflowToolRunInput {
  readonly callId: string;
  readonly execution?: "background" | "blocking";
  readonly executeInput?: JsonValue;
  readonly hookToken: string;
  readonly input: JsonObject;
  readonly owner: InboxAddress;
  readonly resultKind?: "subagent" | "tool";
  readonly session: SessionContext["session"];
  readonly stepIndex: number;
  readonly toolName: string;
  readonly workflowId: string;
}

export interface WorkflowToolRunAddress {
  readonly hookToken: string;
  readonly runId: string;
}
