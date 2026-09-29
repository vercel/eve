import { createHash } from "node:crypto";

export function deriveRootTurnActivityWorkId(input: {
  readonly sessionId: string;
  readonly turnId: string;
}): string {
  return `root:${hashTuple([input.sessionId, input.turnId])}`;
}

export function deriveChildActivityWorkId(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  /**
   * Tells apart the sessions one call opens. Only the legacy `subagent-result`
   * settle omits it, for a child a call started before agents ran as tasks.
   */
  readonly sessionKey?: string;
}): string {
  const session = input.sessionKey === undefined ? "" : `\0${input.sessionKey}`;
  const digest = createHash("sha256")
    .update(`${input.parentSessionId}\0${input.parentTurnId}\0${input.callId}${session}`)
    .digest("hex");
  return `work:${digest}`;
}

function hashTuple(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
