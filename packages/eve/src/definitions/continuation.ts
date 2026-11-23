import type { DeliverHookPayload } from "#channel/types.js";

export const REACTIONS_STATE_KEY = "eve.reactions";

export interface Continuation {
  readonly turnId: string;
  readonly delivery: DeliverHookPayload;
}

export interface SessionEndRequest {
  readonly hook: string;
}

export function continuationKey(sessionId: string, turnId: string): string {
  return `${sessionId}:continue:${turnId}`;
}

export function pendingContinuation(
  serializedContext: Readonly<Record<string, unknown>>,
  latestTurnId: string | undefined,
): DeliverHookPayload | undefined {
  const state = serializedContext[REACTIONS_STATE_KEY] as
    | { readonly continuation?: Continuation; readonly sessionEnd?: SessionEndRequest }
    | undefined;
  if (state?.sessionEnd !== undefined) return undefined;
  return latestTurnId !== undefined && state?.continuation?.turnId === latestTurnId
    ? state.continuation.delivery
    : undefined;
}

export function pendingSessionEnd(
  serializedContext: Readonly<Record<string, unknown>>,
): SessionEndRequest | undefined {
  const state = serializedContext[REACTIONS_STATE_KEY] as
    | { readonly sessionEnd?: SessionEndRequest }
    | undefined;
  return state?.sessionEnd;
}
