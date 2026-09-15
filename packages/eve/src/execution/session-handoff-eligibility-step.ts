import type { DurableSessionState } from "#execution/durable-session-store.js";
import { isSessionStateIdleForHandoff } from "#execution/session-handoff-state.js";

/** Reads durable work using the source deployment's handoff contract. */
export async function isSessionIdleForHandoffStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";
  return isSessionStateIdleForHandoff(input.sessionState);
}
