import type { WorkflowBodyDefinition } from "#execution/tools/workflow/body.js";
import type { WorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";

export interface WorkflowToolRunInput extends WorkflowBodyDefinition {
  readonly hookToken: string;
  readonly owner: WorkflowToolRunOwner;
}

export interface WorkflowToolRunAddress {
  readonly hookToken: string;
  readonly runId: string;
}
