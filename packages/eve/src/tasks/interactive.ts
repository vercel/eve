import type { ContextReader } from "#context/key.js";
import { DelegatedSessionKey, ModeKey, ScheduleIdKey, TurnScheduleIdKey } from "#context/keys.js";
import type { RunMode } from "#shared/run-mode.js";

/**
 * A root session in conversation mode that no caller created. It is decided
 * from facts fixed at creation, so what it implies does not change
 * mid-session, even when a later turn arrives with a caller.
 */
export function isInteractiveRootSession(
  ctx: ContextReader | undefined,
  mode: RunMode | undefined = ctx?.get(ModeKey),
): boolean {
  return mode === "conversation" && ctx?.get(DelegatedSessionKey) !== true;
}

/**
 * Whether a held turn shows its waiting boundary: only a turn of an
 * interactive root session that a schedule did not start. A scheduled,
 * child, or task-mode turn holds without one, so a schedule posts once and a
 * caller gets one reply. A schedule starts the first turn of a session it
 * created, and any turn its delivery starts in an existing session.
 */
export function showsHeldTurnBoundary(
  ctx: ContextReader | undefined,
  turnSequence: number,
): boolean {
  if (ctx === undefined || !isInteractiveRootSession(ctx)) return false;
  if (ctx.get(TurnScheduleIdKey) !== undefined) return false;
  return !(turnSequence === 0 && ctx.get(ScheduleIdKey) !== undefined);
}
