import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";

import type { HumanInputEnding } from "./session.js";
import { mapHeldInputResponsesStep } from "./steps.js";

// How the session workflow body reaches human input: it runs the durable
// steps, and carries out how human input ended a turn.

/**
 * Maps a delivery's channel-specific answers to the requests a held turn waits
 * on. Returns `undefined` when the channel maps none of them.
 */
export async function mapHeldInputResponses(
  cursor: SessionStateCursor,
  delivery: DeliverHookPayload,
  requestIds: ReadonlySet<string>,
): Promise<DeliverHookPayload | undefined> {
  const mapped = await cursor.advance((state) =>
    mapHeldInputResponsesStep({ delivery, requestIds: [...requestIds], ...state }),
  );
  return mapped.delivery;
}

/**
 * The session fails with the code human input gave. Thrown from the session
 * workflow, not a step, so it is not retried; the session reports it as its
 * terminal `session.failed`.
 */
export class HumanInputFailure extends Error {
  constructor(ending: Extract<HumanInputEnding, { readonly kind: "failed" }>) {
    super(ending.message);
    this.name = ending.code;
  }
}
