import type { SessionCapabilities } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

// The session as an owner hands it on: to a successor deployment on Workflow, or to another host
// that restores it. Host-neutral; Workflow's handoff is `handoff.ts`.

/**
 * Cross-deployment checkpoint contract. The successor may run a different eve
 * build than the owner that produced it; bump when any field changes shape so
 * an older successor rejects the handoff instead of misreading state.
 *
 * A successor accepts checkpoints back to `MIN_SESSION_CHECKPOINT_VERSION` and
 * refuses older ones; a bump that keeps its predecessor readable adds the upgrade
 * in `checkpoint-migrations.ts`.
 */
export const SESSION_CHECKPOINT_VERSION = 19;

/** Everything a successor needs to continue an idle session. Hooks are derived from the state. */
export interface SessionCheckpoint {
  readonly admittedDeliveryKeys: readonly string[];
  readonly version: typeof SESSION_CHECKPOINT_VERSION;
  readonly capabilities?: SessionCapabilities;
  readonly history: HarnessModelMessage[];
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutMs: number | false;
}

/** What a session's owner holds between steps, and a successor continues from. */
export type SessionTransferState = Pick<
  SessionCheckpoint,
  "admittedDeliveryKeys" | "history" | "serializedContext" | "sessionState"
>;
