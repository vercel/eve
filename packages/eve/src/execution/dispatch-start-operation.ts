import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import {
  deriveAgentId,
  type AgentIdentity,
  type StartOperation,
} from "#subagents/handles/store.js";

/**
 * Mints deterministic parent-controlled ownership data before the child exists,
 * so durable step replays derive the same handle record.
 */
export function mintStartOperation(input: {
  readonly callId: string;
  readonly name: string;
  readonly nodeId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): { readonly identity: AgentIdentity; readonly operation: StartOperation } {
  // The handle store schema requires every operation field to be non-empty,
  // but it only validates at persist time, where a violation surfaces as an
  // opaque "corrupt agent handle store" fatal several steps away from the
  // fault. Fail here instead, at the site that received the bad value.
  for (const [field, value] of [
    ["callId", input.callId],
    ["parentSessionId", input.parentSessionId],
    ["parentTurnId", input.parentTurnId],
  ] as const) {
    if (value === "") {
      throw new Error(
        `mintStartOperation received an empty ${field}; refusing to derive an agent handle from it.`,
      );
    }
  }
  const operationId = deriveAgentOperationId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  return {
    identity: {
      id: deriveAgentId(input.name, operationId),
      name: input.name,
      nodeId: input.nodeId,
    },
    operation: {
      callId: input.callId,
      id: operationId,
      kind: "start",
      parentTurnId: input.parentTurnId,
    },
  };
}
