import { type AlsContext, type ContextContainer, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";

const PendingTurnSleepDurationKey = new ContextKey<number>("eve.pendingTurnSleepDuration");

/** Step-local pauses are fulfilled by the turn workflow; concurrent calls share the longest pause. */
export function requestTurnSleep(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
    throw new Error("Sleep duration must resolve to a positive safe integer of milliseconds.");
  const ctx = loadContext();
  (ctx as ContextContainer).setVirtualContext(
    PendingTurnSleepDurationKey,
    Math.max(ctx.get(PendingTurnSleepDurationKey) ?? 0, durationMs),
  );
}

export function readTurnSleepDurationMs(ctx: AlsContext): number | undefined {
  return ctx.get(PendingTurnSleepDurationKey);
}
