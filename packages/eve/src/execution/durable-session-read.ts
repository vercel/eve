import type { DurableSession, DurableSessionState } from "#execution/durable-session-store.js";

export const DURABLE_SESSION_VERSION = 2;

export function readDurableSession(state: DurableSessionState): DurableSession {
  if (state.version !== DURABLE_SESSION_VERSION || state.snapshot?.session === undefined) {
    throw new Error("Unsupported session checkpoint. Start a new session on this deployment.");
  }
  return state.snapshot.session;
}
