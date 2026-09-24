import { createHash } from "node:crypto";

/**
 * Derives the stable operation id for one dispatch. All three inputs are
 * parent-controlled, so the id exists before any child does and replaying
 * the same call produces the same operation.
 *
 * Lives in its own module because it needs `node:crypto`, which the session
 * workflow body rejects; operation ids are only minted inside start steps.
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
