import type { TokenUsage } from "#shared/token-usage.js";
import type { DeliverHookPayload, RunInput, SessionCommand } from "#channel/types.js";
import type { SessionCheckpoint } from "#execution/session/checkpoint.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

export const SESSION_HANDOFF_VERSION = 3;

export interface InitialWorkflowEntryInput {
  readonly idempotencyKey?: string;
  readonly startClaim?: "continuation" | "inbox";
  readonly continuationConflictCommand?: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly input: RunInput["input"];
  readonly kind: "initial";
  readonly ownerDeploymentId: string;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly sessionTimeoutMs?: number | false;
  readonly serializedContext: Record<string, unknown>;
}

export type SessionHandoffStart =
  | {
      readonly delivery: DeliverHookPayload;
      readonly reason?: undefined;
    }
  | {
      readonly reason: "compaction" | "prewarm";
      readonly delivery?: undefined;
      readonly sessionTimeoutDeadline?: Date;
    };

export type HandoffWorkflowEntryInput = SessionHandoffStart & {
  readonly activationToken: string;
  readonly attemptKey?: string;
  readonly checkpoint: SessionCheckpoint;
  readonly handoffVersion?: number;
  readonly hookTokens?: readonly string[];
  readonly sourceRunId?: string;
  readonly kind: "handoff";
  readonly ownerDeploymentId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly sessionId: string;
};

export type WorkflowEntryInput = InitialWorkflowEntryInput | HandoffWorkflowEntryInput;

export interface WorkflowEntryResult {
  readonly isError?: boolean;
  readonly usage?: TokenUsage;
  readonly usageDelta?: TokenUsage;
  readonly output: unknown;
}
