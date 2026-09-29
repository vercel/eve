import type { TokenUsage } from "#shared/token-usage.js";
import type { DeliverHookPayload, RunInput, SessionCommand } from "#channel/types.js";
import type { SessionCheckpoint } from "#execution/session/handoff.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

/** Version 2 marks source runs whose Workflow SDK supports forced hook claims. */
export const SESSION_HANDOFF_VERSION = 2;

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
}

/** A successor owner started by a previous owner during a deployment handoff. */
export interface HandoffWorkflowEntryInput {
  readonly activationToken: string;
  readonly checkpoint: SessionCheckpoint;
  /** The one delivery that triggered the handoff; processed before any later arrival. */
  readonly delivery: DeliverHookPayload;
  /** Omitted by version 1 sources, whose hooks cannot safely be force-claimed. */
  readonly handoffVersion?: number;
  readonly kind: "handoff";
  readonly ownerDeploymentId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  /** Stable public identity; also the original run that anchors the stream. */
  readonly sessionId: string;
}

export type WorkflowEntryInput = InitialWorkflowEntryInput | HandoffWorkflowEntryInput;

export interface WorkflowEntryResult {
  readonly isError?: boolean;
  readonly usage?: TokenUsage;
  readonly usageDelta?: TokenUsage;
  readonly output: unknown;
}
