import { createHash } from "node:crypto";

import { deriveAgentOperationId } from "#harness/handles/operation-id.js";

/**
 * Derives the stable task id for one originating subagent call.
 *
 * Reuses the agent-handle operation-id derivation —
 * `hash(parentSessionId, parentTurnId, callId)` — so replayed creation
 * for the same call yields the same task without new machinery, and a
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
  return `task_${deriveAgentOperationId(input).slice(0, 24)}`;
}

/**
 * Derives the task run's private command-hook token.
 *
 * Deterministic on purpose: a durable replay of the dispatch step must
 * re-derive the same token so the duplicate task run loses the hook
 * claim and exits instead of splitting the lifecycle across two runs.
 * Unguessable in practice: the parent session's continuation token is
 * itself a private capability, and the derived token never renders to
 * the model.
 */
export function deriveTaskCommandToken(input: {
  readonly parentContinuationToken: string;
  readonly taskId: string;
}): string {
  return `task:${input.taskId}:${createHash("sha256")
    .update(`${input.taskId}\0${input.parentContinuationToken}`)
    .digest("hex")
    .slice(0, 32)}`;
}

/** Reads the non-secret task id embedded in a private task command token. */
export function readTaskIdFromCommandToken(token: string): string | undefined {
  const match = /^task:(task_[^:]+):[a-f0-9]{32}$/.exec(token);
  return match?.[1];
}
