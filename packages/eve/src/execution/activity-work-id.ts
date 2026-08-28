import { createHash } from "node:crypto";

import { deriveAgentOperationId } from "#harness/handles/operation-id.js";

export function deriveRootTurnActivityWorkId(input: {
  readonly sessionId: string;
  readonly turnId: string;
}): string {
  return `root:${hashTuple([input.sessionId, input.turnId])}`;
}

export function deriveActivityActionId(input: {
  readonly callId: string;
  readonly workId: string;
}): string {
  return `action:${input.workId}:${input.callId}`;
}

export function deriveChildActivityWorkId(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return `work:${deriveAgentOperationId(input)}`;
}

function hashTuple(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
