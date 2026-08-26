import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import { deriveAgentId, type AgentIdentity, type StartOperation } from "#harness/handles/store.js";

/**
 * Mints deterministic parent-controlled ownership data before the child exists,
 * so durable step replays derive the same handle record.
 */
export function mintStartOperation(input: {
  readonly callId: string;
  readonly execution?: "background" | "blocking";
  readonly name: string;
  readonly nodeId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly targetKind?: "local" | "remote";
}): { readonly identity: AgentIdentity; readonly operation: StartOperation } {
  const operationId = deriveAgentOperationId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  return {
    identity: {
      execution: input.execution,
      id: deriveAgentId(input.name, operationId),
      name: input.name,
      nodeId: input.nodeId,
      targetKind: input.targetKind,
    },
    operation: {
      callId: input.callId,
      id: operationId,
      kind: "start",
      parentTurnId: input.parentTurnId,
    },
  };
}
