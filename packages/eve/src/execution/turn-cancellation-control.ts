import {
  sessionCancelHookToken,
  type TurnCancelPayload,
} from "#execution/turn-cancellation-token.js";
import { createTurnHookInbox, type TurnHookInbox } from "#execution/turn-hook-inbox.js";
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
  const inbox = await createTurnHookInbox<TurnCancelPayload>({
    conflict: "return-undefined",
    token: sessionCancelHookToken(input.sessionId),
  });
  if (inbox === undefined) return undefined;

  const controller = new AbortController();
  // The durable abort fires in the read's continuation so its call site
  // is reached deterministically on every replay.
  const requested = consumeMatchingCancel(inbox, input.expectedTurnId).then(() => {
    controller.abort(new TurnCancelledError());
    return "cancel" as const;
  });

  return {
    signal: controller.signal,
    requested,
    dispose: () => inbox.dispose(),
  };
}

// Mismatched turn guards are consumed as no-ops; each read is durable,
// so the skip sequence replays deterministically.
async function consumeMatchingCancel(
  inbox: TurnHookInbox<TurnCancelPayload>,
  expectedTurnId: string,
): Promise<void> {
  while (true) {
    const payload = await inbox.next();
    if (matchesActiveTurn(payload, expectedTurnId)) return;
  }
}

function matchesActiveTurn(payload: unknown, expectedTurnId: string): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const guard = (payload as TurnCancelPayload).turnId;
  return guard === undefined || guard === expectedTurnId;
}
