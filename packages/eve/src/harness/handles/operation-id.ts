import { createHash } from "node:crypto";

/**
 * Derives the stable operation id for one dispatch. All three inputs are
 * parent-controlled, so the id exists before any child does and replaying
 * the same call produces the same operation.
 *
 * Lives apart from the handle store because it needs `node:crypto`: the
 * store module is bundled into the workflow driver body (which rejects
 * Node.js builtins), while operation ids are only ever minted inside
 * dispatch steps.
 */
export function deriveAgentOperationId(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return createHash("sha256")
    .update(`${input.parentSessionId}\0${input.parentTurnId}\0${input.callId}`)
    .digest("hex");
}
