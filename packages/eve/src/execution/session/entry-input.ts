import type { TokenUsage } from "#shared/token-usage.js";
import type { DeliverHookPayload, RunInput, SessionCommand } from "#channel/types.js";
import type { SessionCheckpoint } from "#execution/session/handoff.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

/**
 * Version 3 sources keep their hooks while the successor starts: it takes
 * them over with forced claims and the source hands over what it accepted
 * meanwhile. Earlier sources released their hooks before starting it.
 */
export const SESSION_HANDOFF_VERSION = 3;

/**
 * Serializable workflow-entry input. All runtime state travels via
 * `serializedContext`, which is produced by `serializeContext(ctx)`
 * and deserialized at each `"use step"` boundary.
 */
export interface InitialWorkflowEntryInput {
  readonly idempotencyKey?: string;
  readonly continuationConflictCommand?: Extract<SessionCommand, { readonly kind: "send" }>;
  readonly input: RunInput["input"];
  readonly kind: "initial";
  readonly ownerDeploymentId: string;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly sessionTimeoutMs?: number | false;
  readonly serializedContext: Record<string, unknown>;
}

/** Why a previous owner started a successor, and what the successor does first. */
export type SessionHandoffStart =
  | {
      /** The one delivery that triggered a deployment handoff; processed before any later arrival. */
      readonly delivery: DeliverHookPayload;
      readonly reason?: undefined;
    }
  | {
      /**
       * The previous owner rotated an idle session after compaction or prepared
       * it on the deployment accepting the next interaction.
       */
      readonly reason: "compaction" | "prewarm";
      /**
       * Only sources older than version 3 send one: the lone delivery that
       * arrived before they could move, processed first. Without one, the
       * successor parks until the next input arrives.
       */
      readonly delivery?: DeliverHookPayload;
      /** Proactive preparation preserves the current idle deadline. */
      readonly sessionTimeoutDeadline?: Date;
    };

/** A successor owner started by a previous owner during a handoff. */
export type HandoffWorkflowEntryInput = SessionHandoffStart & {
  readonly activationToken: string;
  /**
   * Version 3: names this attempt, so a duplicate candidate fences itself out
   * and the source's handover reaches the successor that expects it.
   */
  readonly attemptKey?: string;
  readonly checkpoint: SessionCheckpoint;
  /** Omitted by version 1 sources. */
  readonly handoffVersion?: number;
  /** Version 3: the source's logical hook set, which the successor takes over. */
  readonly hookTokens?: readonly string[];
  /** Version 3: the source run, whose handover the successor waits for while it lives. */
  readonly sourceRunId?: string;
  readonly kind: "handoff";
  readonly ownerDeploymentId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  /** Stable public identity; also the original run that anchors the stream. */
  readonly sessionId: string;
};

export type WorkflowEntryInput = InitialWorkflowEntryInput | HandoffWorkflowEntryInput;

export interface WorkflowEntryResult {
  readonly isError?: boolean;
  readonly usage?: TokenUsage;
  readonly usageDelta?: TokenUsage;
  readonly output: unknown;
}
