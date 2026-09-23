import { dispatchSessionEventHooksStep } from "#execution/session/dispatch-event-hooks-step.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";

/** Keeps successful publication outside the hook step's retry boundary. */
export async function handleSubagentEvent(input: Parameters<typeof emitSubagentEventStep>[0]) {
  const published = await emitSubagentEventStep(input);
  if (published.suppressed) {
    return { serializedContext: published.serializedContext, sessionState: input.sessionState };
  }
  return await dispatchSessionEventHooksStep({
    event: published.event,
    serializedContext: published.serializedContext,
    sessionState: input.sessionState,
  });
}
