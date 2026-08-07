import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { TurnCancelPayload } from "#execution/turn-cancellation-token.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** Forwards an inbox cancellation command to one private active-turn hook. */
export async function forwardTurnCancellationStep(input: {
  readonly payload: TurnCancelPayload;
  readonly token: string;
}): Promise<boolean> {
  "use step";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await resumeHook(input.token, input.payload);
      return true;
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      if (attempt === 49) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }

  return false;
}
