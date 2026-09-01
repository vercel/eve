import { getRun } from "#internal/workflow/runtime.js";

import type { TurnResultPayload } from "#execution/turn-control-protocol.js";

/** Waits for a turn child workflow to return its terminal driver action. */
export async function awaitTurnRunResultStep(input: {
  readonly runId: string;
}): Promise<TurnResultPayload | void> {
  "use step";
  return await getRun<TurnResultPayload | void>(input.runId).returnValue;
}
