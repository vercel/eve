import { UnsentCallerEventsKey, type UnsentCallerEvent } from "#context/keys.js";
import { sendCallerEvent } from "#tasks/input-forward.js";

/**
 * Sends the caller events a session still owes, in order, and throws on a
 * failure worth retrying, such as the caller's `503` while its session moves
 * to another deployment, so the workflow retries the step. Returns the
 * context without them.
 */
export async function flushUnsentCallerEventsStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  "use step";

  const value = input.serializedContext[UnsentCallerEventsKey.name];
  const unsent = Array.isArray(value) ? (value as UnsentCallerEvent[]) : [];
  for (const entry of unsent) {
    if ((await sendCallerEvent(entry, { logFailures: true })) === "retry") {
      throw new Error("A remote caller did not take an input request; the step retries it.");
    }
  }
  const next = { ...input.serializedContext };
  delete next[UnsentCallerEventsKey.name];
  return next;
}
