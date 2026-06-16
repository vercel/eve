import type { PromptColors } from "#setup/cli/index.js";

/**
 * Two-stage Escape-to-quit state for an interactive prompt.
 *
 * The wizard collects several answers in a row, so quitting on the very first
 * Escape is easy to trigger by accident. Instead the first Escape "arms" a quit
 * hint, the second Escape quits, and any other key disarms. This mirrors the
 * familiar "press again to exit" pattern from editors and shells.
 */
export interface QuitGuardState {
  /** True after a single Escape, when the next Escape will quit the wizard. */
  readonly armed: boolean;
}

/** Nothing armed yet: the starting state for every prompt. */
export const initialQuitGuardState: QuitGuardState = { armed: false };

/**
 * Key intents the guard distinguishes. Escape arms or quits; every other key is
 * collapsed to `other-key`, which only matters while armed (it disarms).
 */
export type QuitGuardEvent = { type: "escape" } | { type: "other-key" };

/**
 * Side effect the prompt wiring should perform after the transition. Only `quit`
 * requires the caller to act (cancel the prompt); `arm`/`disarm`/`none` are
 * reflected purely by re-rendering with the returned {@link QuitGuardState}.
 */
export type QuitGuardAction = "none" | "arm" | "quit" | "disarm";

/**
 * Advances the guard for a single keypress.
 *
 * - Escape while disarmed arms the guard and surfaces the quit hint.
 * - Escape while armed quits.
 * - Any other key while armed disarms (the user kept going), clearing the hint.
 */
export function reduceQuitGuard(
  state: QuitGuardState,
  event: QuitGuardEvent,
): { state: QuitGuardState; action: QuitGuardAction } {
  if (event.type === "escape") {
    return state.armed ? { state, action: "quit" } : { state: { armed: true }, action: "arm" };
  }
  return state.armed
    ? { state: initialQuitGuardState, action: "disarm" }
    : { state, action: "none" };
}

/**
 * The status note shown on the prompt's corner line while the guard is armed, or
 * `undefined` when it is not. Rendered as a corner-line tail so it reads like a
 * status bar pinned under the active prompt.
 */
export function quitHintNote(state: QuitGuardState, colors: PromptColors): string | undefined {
  if (!state.armed) return undefined;
  return `${colors.dim("Press")} ${colors.yellow("Esc")} ${colors.dim("again to quit, or any key to continue")}`;
}
