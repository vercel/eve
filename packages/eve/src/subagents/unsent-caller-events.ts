import { UnsentCallerEventsKey } from "#context/keys.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { flushUnsentCallerEventsStep } from "#subagents/unsent-caller-events-step.js";

/**
 * Sends the input requests and authorization events a remotely called
 * session could not forward to its caller when they happened, before the
 * session waits for input. Events its caller never takes, even after the
 * step's retries, are dropped; the call's time limit then ends the caller's
 * wait. Runs in the workflow body, so it reaches the network only through
 * its step.
 */
export async function flushUnsentCallerEvents(cursor: SessionStateCursor): Promise<void> {
  const unsent = cursor.serializedContext[UnsentCallerEventsKey.name];
  if (!Array.isArray(unsent) || unsent.length === 0) return;
  try {
    await cursor.apply({
      serializedContext: await flushUnsentCallerEventsStep({
        serializedContext: cursor.serializedContext,
      }),
    });
  } catch {
    const { [UnsentCallerEventsKey.name]: _dropped, ...rest } = cursor.serializedContext;
    await cursor.apply({ serializedContext: rest });
  }
}
