import { type AlsContext, type ContextContainer, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";

const PendingTurnSleepDurationKey = new ContextKey<number>("eve.pendingTurnSleepDuration");

/**
 * Requests a durable pause before the turn's next action.
 *
 * The request is step-local: tool execution records it in virtual context,
 * then `turnStep` projects it onto its result for `turnWorkflow` to fulfill.
 * Concurrent sleep calls share the wait, so the longest requested duration
 * wins.
 */
export function requestTurnSleep(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error("Sleep duration must resolve to a positive safe integer of milliseconds.");
  }

  const ctx = loadContext();
  const pendingDurationMs = ctx.get(PendingTurnSleepDurationKey) ?? 0;
  asContainer(ctx).setVirtualContext(
    PendingTurnSleepDurationKey,
    Math.max(pendingDurationMs, durationMs),
  );
}

/** Returns the longest sleep requested during the current turn step. */
export function readTurnSleepDurationMs(ctx: AlsContext): number | undefined {
  return ctx.get(PendingTurnSleepDurationKey);
}

function asContainer(ctx: AlsContext): ContextContainer {
  return ctx as ContextContainer;
}
