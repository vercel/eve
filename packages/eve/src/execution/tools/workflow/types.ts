import type { ActivityObserverConfig } from "#channel/types.js";
import type { TaskView } from "#tasks/types.js";
import type { WorkflowBodyDefinition } from "#execution/tools/workflow/body.js";
import type { WorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";

export interface WorkflowToolRunInput extends WorkflowBodyDefinition {
  readonly execution?: "background" | "blocking";
  readonly hookToken: string;
  readonly owner: WorkflowToolRunOwner;
}

export interface WorkflowToolRunAddress {
  readonly hookToken: string;
  readonly runId: string;
}

export interface BackgroundWorkflowToolRunInput {
  readonly activityObserver?: ActivityObserverConfig;
  readonly initialView: TaskView;
  readonly parentContinuationToken: string;
  readonly taskInboxToken: string;
  readonly workflow: WorkflowBodyDefinition;
}
