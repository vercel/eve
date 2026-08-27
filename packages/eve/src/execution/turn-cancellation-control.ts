import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  turnCancellationHookToken,
  type TurnCancelPayload,
} from "#execution/turn-cancellation-token.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

/**
 * Owns one turn's cancellation surface inside the turn workflow: the
 * turn-private cancel hook and the durable `AbortController` whose
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
 * Creates and claims the private cancel hook for one turn workflow run.
 * Returns `undefined` when the token is still claimed by a crashed prior
 * run — the turn then runs uncancellable rather than failing.
 */
export async function createTurnCancellationControl(input: {
  readonly controlToken: string;
  readonly expectedTurnId: string;
}): Promise<TurnCancellationControl | undefined> {
  const hook = createHook<TurnCancelPayload>({
    token: turnCancellationHookToken(input.controlToken),
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
  // The abort must fire inside the read continuation — not a chained
  // `.then` — so the signal is already flipped when a same-drain
  // continuation (the turn loop's settle check) reads it; one microtask
  // later and an ordinary completion swallows the cancel.
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
// so the skip sequence replays deterministically. `onCancel` fires inside
// the matching read's continuation (see the abort ordering note above).
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
