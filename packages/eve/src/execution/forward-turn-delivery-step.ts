import type { TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** Forwards one accepted public delivery to the private inbox of its requesting turn. */
export async function forwardTurnDeliveryStep(input: {
  readonly inboxToken: string;
  readonly payload: TurnInboxPayload;
}): Promise<void> {
  "use step";

  await resumeHook(input.inboxToken, input.payload);
}
