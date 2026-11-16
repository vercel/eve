import type { TokenUsage } from "#shared/token-usage.js";
import type { DeliverHookPayload, RunInput, SessionCommand } from "#channel/types.js";
import type { SessionCheckpoint } from "#execution/session/checkpoint.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

/**
 * Sources keep their hooks while the successor starts: it takes them over
 * with forced claims and the source hands over what it accepted meanwhile.
 * Successors no longer boot from earlier sources, which released their hooks
 * first.
 */
export const SESSION_HANDOFF_VERSION = 3;

/**
 * Serializable workflow-entry input. All runtime state travels via
 * `serializedContext`, which is produced by `serializeContext(ctx)`
 * and deserialized at each `"use step"` boundary.
 */
export interface InitialWorkflowEntryInput {
  readonly idempotencyKey?: string;
  /**
   * The address `start()` claimed with the run's admission: the continuation
   * address, or the session's own inbox when it has none. The run opens that
   * hook rather than registering it, and the claim cannot conflict.
   */
  readonly startClaim?: "continuation" | "inbox";
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
      /** The successor parks until the next input arrives. */
      readonly delivery?: undefined;
      /** Proactive preparation preserves the current idle deadline. */
      readonly sessionTimeoutDeadline?: Date;
    };

/** A successor owner started by a previous owner during a handoff. */
export type HandoffWorkflowEntryInput = SessionHandoffStart & {
  readonly activationToken: string;
  /**
   * Names this attempt, so a duplicate candidate fences itself out and the
   * source's handover reaches the successor that expects it. Absent, like
   * `hookTokens` and `sourceRunId`, only from sources before version 3.
   */
  readonly attemptKey?: string;
  readonly checkpoint: SessionCheckpoint;
  readonly handoffVersion?: number;
  /** The source's logical hook set, which the successor takes over. */
  readonly hookTokens?: readonly string[];
  /** The source run, whose handover the successor waits for while it lives. */
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
