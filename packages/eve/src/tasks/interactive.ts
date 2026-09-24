import type { ContextReader } from "#context/key.js";
import { DelegatedSessionKey, ModeKey } from "#context/keys.js";
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
