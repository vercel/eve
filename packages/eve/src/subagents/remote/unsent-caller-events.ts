import { UnsentCallerEventsKey, type UnsentCallerEvent } from "#context/keys.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { flushUnsentCallerEventsStep } from "#subagents/remote/unsent-caller-events-step.js";

/**
 * Sends the human-input events a remotely called session could not forward
 * to its caller when they happened, before the session waits for input.
 * When the caller still does not take them after the step's retries, a
 * request, approval, or sign-in event is dropped, and the call's time limit
 * bounds the caller's wait for it. A resolution is kept for the next flush:
 * without it, the caller keeps waiting on a request with its task's clock
 * stopped. A caller that refuses an event outright drops it in the step.
 * Runs in the workflow body, so it reaches the network only through its step.
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
    const { [UnsentCallerEventsKey.name]: _unsent, ...rest } = cursor.serializedContext;
    const kept = (unsent as UnsentCallerEvent[]).filter(
      ({ body }) =>
        (body.event as { readonly type?: unknown } | undefined)?.type === "input.resolved",
    );
    await cursor.apply({
      serializedContext: kept.length === 0 ? rest : { ...rest, [UnsentCallerEventsKey.name]: kept },
    });
  }
}
