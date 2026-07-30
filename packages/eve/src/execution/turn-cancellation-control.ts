import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  sessionCancelHookToken,
  type TurnCancelPayload,
} from "#execution/turn-cancellation-token.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

/**
 * Owns one turn's cancellation surface inside the turn workflow: the
 * session-scoped cancel hook and the durable `AbortController` whose
 * signal is serialized into every `turnStep`. Must be created inside a
 * `"use workflow"` body.
 */
export interface TurnCancellationControl {
  /** Turn signal to serialize into each `turnStep` input. */
  readonly signal: AbortSignal;
  /**
   * Resolves `"cancel"` once a matching cancel payload is consumed and
   * the signal aborted. Race it against turn-owned awaits — never
   * `await` it alone.
   */
  readonly requested: Promise<"cancel">;
  /** Disposes the hook, abandoning any outstanding read. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Creates and claims the session cancel hook for one turn workflow run.
 * Returns `undefined` when the token is still claimed by a crashed prior
 * run — the turn then runs uncancellable rather than failing.
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
  // The abort fires inside the read continuation itself — not a chained
  // `.then` — so the signal flips in the same microtask that consumes the
  // payload. When a wake replays a journaled cancel alongside a completed
  // step, the turn loop checks `signal.aborted` in the step's continuation;
  // a chained abort would run one microtask later and lose to that check,
  // letting an ordinary completion swallow the cancel.
  const requested = consumeMatchingCancel(iterator, input.expectedTurnId, () => {
    controller.abort(new TurnCancelledError());
  }).then(() => "cancel" as const);

  let disposed = false;
  return {
    signal: controller.signal,
    requested,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Never `iterator.return()`: it would await the pending durable
      // read forever, leaving the run `running` and its hooks unswept.
      await disposeHook(hook);
    },
  };
}

// Mismatched turn guards are consumed as no-ops; each read is durable,
// so the skip sequence replays deterministically. `onCancel` runs
// synchronously within the matching read's continuation (see the abort
// ordering note in `createTurnCancellationControl`).
async function consumeMatchingCancel(
  iterator: AsyncIterator<TurnCancelPayload>,
  expectedTurnId: string,
  onCancel: () => void,
): Promise<void> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return await new Promise<never>(() => {});
    if (matchesActiveTurn(next.value, expectedTurnId)) {
      onCancel();
      return;
    }
  }
}

function matchesActiveTurn(payload: unknown, expectedTurnId: string): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const guard = (payload as TurnCancelPayload).turnId;
  return guard === undefined || guard === expectedTurnId;
}
