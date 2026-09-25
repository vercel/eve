import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import { isObject } from "#shared/guards.js";

export interface LegacyTurnInput {
  readonly completionToken: string;
  readonly capabilities?: SessionCapabilities;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: Record<string, unknown> & { sessionId: string };
  /** Only an uncommitted `deliver` continues as the first turn; controls and results were the driver's. */
  readonly delivery: DeliverHookPayload | undefined;
  readonly inputCommitted: boolean;
}

/** Reads a versioned turn-workflow input from a pre-cutover driver (eve 0.45 – 0.55). */
export function readLegacyTurnInput(value: unknown): LegacyTurnInput {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2))
    throw new Error("Unsupported legacy turn input version.");
  const step = value.stepInput;
  if (!isObject(step) || typeof value.completionToken !== "string" || !value.completionToken)
    throw new Error("Invalid legacy turn input.");
  const committed =
    isObject(value.initialStep) && isObject(value.initialStep.result)
      ? value.initialStep.result
      : undefined;
  const state =
    (committed?.action === "cancelled" ? committed.backgroundTaskState : undefined) ??
    committed?.sessionState ??
    committed?.backgroundTaskState ??
    step.sessionState;
  const context =
    committed?.serializedContext ?? committed?.backgroundTaskContext ?? step.serializedContext;
  if (
    !isObject(state) ||
    typeof state.sessionId !== "string" ||
    !state.sessionId ||
    !isObject(context) ||
    step.parentWritable === undefined
  )
    throw new Error("Legacy turn input has no session checkpoint or output stream.");
  const delivery = step.input;
  if (
    committed === undefined &&
    delivery !== undefined &&
    (!isObject(delivery) ||
      !["deliver", "clear", "compact", "runtime-action-result"].includes(String(delivery.kind)) ||
      (delivery.kind === "deliver" && !Array.isArray(delivery.payloads)))
  )
    throw new Error("Unsupported legacy turn delivery.");
  const uncommittedDelivery =
    committed === undefined && isObject(delivery) && delivery.kind === "deliver"
      ? (delivery as DeliverHookPayload | Record<string, unknown>)
      : undefined;
  return {
    completionToken: value.completionToken,
    capabilities: value.capabilities as SessionCapabilities | undefined,
    retention: value.retention as AgentWorkflowRetentionDefinition | undefined,
    // The former driver's wire field; the stream is the session's, not a parent's.
    sessionWritable: step.parentWritable as WritableStream<Uint8Array>,
    serializedContext: context,
    sessionState: state as LegacyTurnInput["sessionState"],
    delivery: uncommittedDelivery as DeliverHookPayload | undefined,
    inputCommitted: committed !== undefined,
  };
}
