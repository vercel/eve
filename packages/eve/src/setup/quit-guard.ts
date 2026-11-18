import type { PromptColors } from "#setup/cli/index.js";

export interface QuitGuardState {
  readonly armed: boolean;
}

export const initialQuitGuardState: QuitGuardState = { armed: false };

type QuitGuardEvent = { type: "escape" } | { type: "other-key" };

type QuitGuardAction = "none" | "arm" | "quit" | "disarm";

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

export function quitHintNote(state: QuitGuardState, colors: PromptColors): string | undefined {
  if (!state.armed) return undefined;
  return `${colors.dim("Press")} ${colors.yellow("Esc")} ${colors.dim("again to quit, or any key to continue")}`;
}
