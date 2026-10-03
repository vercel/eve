import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";

import { mapHeldInputResponses } from "./session.js";

// The durable steps that apply human input around a turn. Only steps live
// here: a `"use step"` module cannot export plain helpers into a workflow body.

/** Maps a delivery's channel-specific answers for a held turn; see `mapHeldInputResponses`. */
export async function mapHeldInputResponsesStep(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<WithSessionStateDelta<{ readonly delivery: DeliverHookPayload | undefined }>> {
  "use step";
  return await withSessionStateDelta(input, async () => await mapHeldInputResponses(input));
}
