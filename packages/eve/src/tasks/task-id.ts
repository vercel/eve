import { createHash } from "node:crypto";

/**
 * Derives the stable task id for one originating background call.
 *
 * Uses `hash(parentSessionId, parentTurnId, callId)` so replayed creation
 * for the same call yields the same task, and a
 * task can never be confused with a child session id or continuation
 * token.
 *
 * Lives apart from the pure task modules because the derivation needs
 * `node:crypto`, which workflow bodies reject; ids are only ever minted
 * inside dispatch steps.
 */
export function deriveTaskId(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return `task_${createHash("sha256")
    .update(`${input.parentSessionId}\0${input.parentTurnId}\0${input.callId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Derives the task run's private inbox token.
 *
 * Deterministic on purpose: a durable replay of the dispatch step must
 * re-derive the same token so the duplicate task run loses the hook
 * claim and exits instead of splitting the lifecycle across two runs.
 * Unguessable in practice: the parent session's continuation token is
 * itself a private capability, and the derived token never renders to
 * the model.
 */
export function deriveTaskInboxToken(input: {
  readonly parentContinuationToken: string;
  readonly taskId: string;
}): string {
  return `task:${input.taskId}:${createHash("sha256")
    .update(`${input.taskId}\0${input.parentContinuationToken}`)
    .digest("hex")
    .slice(0, 32)}`;
}
