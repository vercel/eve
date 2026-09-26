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
}): string {
  const digest = createHash("sha256")
    .update(`${input.parentSessionId}\0${input.parentTurnId}\0${input.callId}`)
    .digest("hex");
  return `work:${digest}`;
}

function hashTuple(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
