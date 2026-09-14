import { mintStartOperation } from "#execution/dispatch-start-operation.js";

/** Derives the one deterministic identity shared by subagent receipts and dispatch. */
export function createSubagentReceiptIdentity(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly subagentName: string;
  readonly nodeId: string;
}) {
  return mintStartOperation({
    callId: input.callId,
    name: input.subagentName,
    nodeId: input.nodeId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
}
