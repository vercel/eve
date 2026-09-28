import {
  publishSessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/** Publishes a subagent notification without model preparation. */
export async function emitSubagentEventStep(
  input: SessionStepState & { readonly event: UnstampedMessageStreamEvent },
): Promise<PublishedSessionEvents> {
  "use step";

  return await publishSessionEvents(input, [input.event]);
}
