import type { SessionCapabilities } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";

export const SESSION_CHECKPOINT_VERSION = 19;

export interface SessionCheckpoint {
  readonly admittedDeliveryKeys: readonly string[];
  readonly version: typeof SESSION_CHECKPOINT_VERSION;
  readonly capabilities?: SessionCapabilities;
  readonly history: HarnessModelMessage[];
  readonly queueHoldMs?: number;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutMs: number | false;
}

export type SessionTransferState = Pick<
  SessionCheckpoint,
  "admittedDeliveryKeys" | "history" | "serializedContext" | "sessionState"
>;
