import type { DeliverHookPayload, RunInput, SessionCommand } from "#channel/types.js";
import type { SessionCheckpoint } from "#execution/session-handoff.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

/**
 * Serializable workflow-entry input. All runtime state travels via
 * `serializedContext`, which is produced by `serializeContext(ctx)`
 * and deserialized at each `"use step"` boundary.
 */
export interface InitialWorkflowEntryInput {
  readonly activityCollectorRunId?: string;
  readonly continuationConflictCommand?: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly input: RunInput["input"];
  readonly kind: "initial";
  readonly limits?: RunInput["limits"];
  readonly ownerDeploymentId: string;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly sessionTimeoutMs?: number | false;
  readonly serializedContext: Record<string, unknown>;
  readonly taskId?: string;
}

export interface HandoffWorkflowEntryInput {
  readonly activationToken: string;
  readonly checkpoint: SessionCheckpoint;
  readonly delivery: DeliverHookPayload;
  readonly kind: "handoff";
  readonly ownerDeploymentId: string;
  readonly parentWritable: WritableStream<Uint8Array>;
}

export type WorkflowEntryInput = InitialWorkflowEntryInput | HandoffWorkflowEntryInput;

export interface WorkflowEntryResult {
  readonly output: unknown;
}
