import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

/**
 * Derives the session-scoped cancel hook token from the session id.
 *
 * The token is stable for the session's lifetime so a cancel trigger can
 * address it from the session id alone — no per-turn token discovery.
 * Each turn workflow run claims it at turn start and disposes it before
 * publishing its turn result, so at most one live cancel hook exists per
 * session and the next turn's claim is never raced by a stale one.
 */
export function sessionCancelHookToken(sessionId: string): string {
  return `${sessionId}:cancel`;
}

/**
 * Payload accepted by the session cancel hook.
 *
 * `turnId` is an optional guard: when set, the cancel applies only while
 * that turn is active — a cancel that raced a turn boundary is consumed
 * as a benign no-op instead of cancelling a turn the caller never saw.
 * Omitting it cancels whatever turn is currently running.
 */
export interface TurnCancelPayload {
  readonly turnId?: string;
}

/**
 * Owns one turn's cancellation surface inside the turn workflow: the
 * session-scoped cancel hook and the durable `AbortController` whose
 * signal is serialized into every `turnStep`.
 *
 * The abort fires in the continuation of the cancel-hook read, keying it
 * to the `hook_received` journal event so it is replay-deterministic.
 * Must be created inside a `"use workflow"` body.
 */
export interface TurnCancellationControl {
  /** Turn signal to serialize into each `turnStep` input. */
  readonly signal: AbortSignal;
  /**
   * Resolves `"cancel"` once a cancel payload matching the active turn
   * is consumed and the turn signal aborted. Race it against turn-owned
   * awaits — never `await` it alone.
   */
  readonly requested: Promise<"cancel">;
  /**
   * Disposes the hook; an outstanding cancel read is abandoned.
   * Idempotent — the turn workflow disposes before publishing its turn
   * result and again in teardown.
   */
  dispose(): Promise<void>;
}

/**
 * Creates and claims the session cancel hook for one turn workflow run.
 *
 * Returns `undefined` when the token is still claimed by another run —
 * residue of a crashed prior turn whose terminal cleanup has not swept
 * its hooks yet. The turn then runs uncancellable rather than failing:
 * a cancel resumed against the stale hook lands on a dead run and is a
 * benign no-op.
 */
export async function createTurnCancellationControl(input: {
  readonly expectedTurnId: string;
  readonly sessionId: string;
}): Promise<TurnCancellationControl | undefined> {
  const hook = createHook<TurnCancelPayload>({
    token: sessionCancelHookToken(input.sessionId),
  });
  // Hook promises and iterators share one durable cursor. Create the
  // iterator before claiming so conflict replay is consumed by
  // getConflict(), not a later iterator read.
  const iterator = hook[Symbol.asyncIterator]();

  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (isHookConflictError(error)) return undefined;
    throw error;
  }

  const controller = new AbortController();
  const requested = consumeMatchingCancel(iterator, input.expectedTurnId).then(() => {
    controller.abort(new TurnCancelledError());
    return "cancel" as const;
  });

  let disposed = false;
  return {
    signal: controller.signal,
    requested,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Dispose-only, never `iterator.return()`: the iterator is suspended
      // in a pending durable read that `return()` would wait on forever,
      // leaving the run `running` and its hooks unswept. Disposal drops
      // the read.
      await disposeHook(hook);
    },
  };
}

/**
 * Reads cancel payloads until one matches the active turn. Mismatched
 * turn guards are consumed as no-ops; each read is a durable hook read,
 * so the skip sequence replays deterministically.
 */
async function consumeMatchingCancel(
  iterator: AsyncIterator<TurnCancelPayload>,
  expectedTurnId: string,
): Promise<void> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return await new Promise<never>(() => {});
    if (matchesActiveTurn(next.value, expectedTurnId)) return;
  }
}

function matchesActiveTurn(payload: unknown, expectedTurnId: string): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const guard = (payload as TurnCancelPayload).turnId;
  return guard === undefined || guard === expectedTurnId;
}
