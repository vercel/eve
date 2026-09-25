import type { SessionCapabilities } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";

/**
 * Cross-deployment checkpoint contract. The successor may run a different eve
 * build than the owner that produced it; bump when any field changes shape so
 * an incompatible successor rejects the handoff instead of misreading state.
 * Dynamic skill manifests retain instruction bodies and package revisions.
 */
export const SESSION_CHECKPOINT_VERSION = 8;

/** Everything a successor needs to continue an idle session. Hooks are derived from the state. */
export interface SessionCheckpoint {
  readonly version: typeof SESSION_CHECKPOINT_VERSION;
  readonly capabilities?: SessionCapabilities;
  readonly mode: RunMode;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutMs: number | false;
}

export type SessionOwnerActivation =
  | { readonly kind: "active" }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      /** Commands accepted by partial successor claims before startup failed. */
      readonly payloads: readonly SessionInboxPayload[];
    };

export type SessionTransferOutcome =
  | { readonly kind: "transferred" }
  | {
      readonly kind: "retained";
      readonly reason:
        | "same-deployment"
        | "missing-deployment"
        | "not-idle"
        | "busy"
        | "accepted-during-release"
        | "activation-failed";
    };

/**
 * How an owner moves its hooks to a successor. A run started on a Workflow
 * spec that supports forced claims hands off by `takeover`: the successor
 * force-claims every hook in place. Older runs cannot be taken from, so they
 * `release` first (`legacy-handoff.ts`).
 */
export type SessionHandoffProtocol = "takeover" | "release";

export interface SessionHandoffInput {
  readonly checkpoint: Omit<SessionCheckpoint, "serializedContext" | "sessionState" | "version">;
  readonly deploymentId: string;
  readonly inbox: SessionInboxHandle;
  readonly isInitialOwner: boolean;
  readonly sessionId: string;
}

/**
 * The sole boundary for moving an idle session to another exact deployment.
 * Constructed once per owner; `tryTransfer()` is attempted per eligible selection.
 */
export interface SessionHandoff {
  /**
   * Attempts to move the session to the selected delivery's deployment. The
   * outcome states whether the successor activated or this owner retained it.
   */
  tryTransfer(
    selection: TurnSelection,
    state: Pick<SessionCheckpoint, "serializedContext" | "sessionState">,
  ): Promise<SessionTransferOutcome>;
  /** After a transfer, the original run parks until the final owner reports the session result. */
  awaitAnchoredResult(): Promise<WorkflowEntryResult>;
  disposeAnchor(): Promise<void>;
}

export function sessionAnchorToken(sessionId: string): string {
  return `${sessionId}:anchor`;
}
